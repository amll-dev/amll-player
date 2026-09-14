use std::{
    ffi::c_void,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread::{self},
};

use anyhow::{Result, anyhow};
use strategy::{LayoutParams, LegacyStrategy, TaskbarLayout, TaskbarStrategy, Win11Strategy};
use utils::get_windows_build_number;
use windows::{
    Win32::{
        Foundation::{CloseHandle, HANDLE, HWND, WAIT_OBJECT_0},
        System::{
            Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize},
            Registry::{
                HKEY, HKEY_CURRENT_USER, KEY_NOTIFY, REG_NOTIFY_CHANGE_LAST_SET, RegCloseKey,
                RegNotifyChangeKeyValue, RegOpenKeyExW,
            },
            Threading::{CreateEventW, INFINITE, SetEvent, WaitForMultipleObjects},
        },
    },
    core::w,
};

/// 任务列表和歌词之间的微小间距
pub const GAP: i32 = 10;

mod logger;
mod strategy;
mod tray_watcher;
mod uia;
mod uia_watcher;
mod utils;

pub use strategy::Rect;
pub use tray_watcher::TrayWatcher;
pub use uia_watcher::UiaWatcher;

pub type TaskbarLayoutCallback = Box<dyn Fn(TaskbarLayout) + Send + 'static>;
pub type RegistryChangedCallback = Box<dyn Fn() + Send + Sync + 'static>;

enum TaskbarCommand {
    Embed { hwnd_ptr: usize },
    Update { width: i32 },
    Stop,
}

pub struct TaskbarService {
    sender: Sender<TaskbarCommand>,
    stopped: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl TaskbarService {
    pub fn new<F>(callback: F) -> Self
    where
        F: Fn(TaskbarLayout) + Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = stopped.clone();

        let worker = thread::spawn(move || {
            let callback: TaskbarLayoutCallback = Box::new(callback);
            worker_loop(&rx, &callback, &worker_stopped);
        });

        Self {
            sender: tx,
            stopped,
            worker: Some(worker),
        }
    }

    pub fn embed_window_by_ptr(&self, hwnd_ptr: usize) {
        let _ = self.sender.send(TaskbarCommand::Embed { hwnd_ptr });
    }

    pub fn embed_window(&self, hwnd: HWND) {
        self.embed_window_by_ptr(hwnd.0 as usize);
    }

    pub fn update(&self, lyric_width: i32) {
        let _ = self
            .sender
            .send(TaskbarCommand::Update { width: lyric_width });
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let _ = self.sender.send(TaskbarCommand::Stop);
    }

    /// Stop queued HWND operations and wait for any operation already running.
    /// Call from a background thread: layout callbacks may need the UI thread.
    pub fn stop_and_join(&mut self) {
        self.stop();
        if let Some(worker) = self.worker.take()
            && worker.thread().id() != thread::current().id()
        {
            let _ = worker.join();
        }
    }
}

impl Drop for TaskbarService {
    fn drop(&mut self) {
        self.stop();
    }
}

fn worker_loop(
    rx: &Receiver<TaskbarCommand>,
    callback: &TaskbarLayoutCallback,
    stopped: &AtomicBool,
) {
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() {
            error!("CoInitializeEx 失败: {hr:?}");
            return;
        }
    }

    let mut strategy = create_strategy();

    run_commands(rx, callback, stopped, &mut strategy);

    if let Some(s) = strategy.as_ref() {
        s.restore();
    }
    drop(strategy);
    unsafe {
        CoUninitialize();
    }
}

fn run_commands(
    rx: &Receiver<TaskbarCommand>,
    callback: &TaskbarLayoutCallback,
    stopped: &AtomicBool,
    strategy: &mut Option<Box<dyn TaskbarStrategy>>,
) {
    while let Ok(msg) = rx.recv() {
        if stopped.load(Ordering::SeqCst) {
            break;
        }
        match msg {
            TaskbarCommand::Embed { hwnd_ptr } => {
                let hwnd = HWND(hwnd_ptr as *mut c_void);
                if let Some(s) = strategy.as_ref() {
                    info!(?hwnd_ptr, "正在嵌入窗口",);
                    if !s.embed_window(hwnd) {
                        error!("嵌入窗口失败");
                    }
                }
            }

            TaskbarCommand::Update { width } => {
                let mut final_width = width;
                let mut stop_signal = false;

                while let Ok(next_msg) = rx.try_recv() {
                    if stopped.load(Ordering::SeqCst) {
                        stop_signal = true;
                        break;
                    }
                    match next_msg {
                        TaskbarCommand::Update { width: w } => final_width = w,
                        TaskbarCommand::Embed { hwnd_ptr } => {
                            let hwnd = HWND(hwnd_ptr as *mut c_void);
                            if let Some(s) = strategy.as_ref() {
                                s.embed_window(hwnd);
                            }
                        }
                        TaskbarCommand::Stop => {
                            stop_signal = true;
                            break;
                        }
                    }
                }

                if stop_signal || stopped.load(Ordering::SeqCst) {
                    break;
                }

                if let Some(s) = strategy.as_mut() {
                    let params = LayoutParams {
                        lyric_width: final_width,
                    };
                    if let Some(layout) = s.update_layout(params) {
                        callback(layout);
                    }
                }
            }

            TaskbarCommand::Stop => {
                break;
            }
        }
    }
}

#[cfg(test)]
mod service_shutdown_tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;

    struct BlockingStrategy {
        entered: Sender<usize>,
        resume: Receiver<()>,
    }

    impl TaskbarStrategy for BlockingStrategy {
        fn init(&mut self) -> bool {
            true
        }
        fn embed_window(&self, hwnd: HWND) -> bool {
            self.entered.send(hwnd.0 as usize).unwrap();
            self.resume.recv().unwrap();
            true
        }
        fn update_layout(&mut self, _: LayoutParams) -> Option<TaskbarLayout> {
            None
        }
        fn restore(&self) {}
    }

    #[test]
    fn stopping_discards_queued_hwnd_commands_and_join_waits_for_the_running_one() {
        let (sender, receiver) = mpsc::channel();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = stopped.clone();
        let worker = thread::spawn(move || {
            let mut strategy: Option<Box<dyn TaskbarStrategy>> = Some(Box::new(BlockingStrategy {
                entered: entered_tx,
                resume: resume_rx,
            }));
            let callback: TaskbarLayoutCallback = Box::new(|_| {});
            run_commands(&receiver, &callback, &worker_stopped, &mut strategy);
        });
        let mut service = TaskbarService {
            sender,
            stopped,
            worker: Some(worker),
        };
        service.embed_window_by_ptr(100);
        assert_eq!(
            entered_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            100
        );
        service.embed_window_by_ptr(200);
        service.stop();

        let (joined_tx, joined_rx) = mpsc::channel();
        let joining = thread::spawn(move || {
            service.stop_and_join();
            joined_tx.send(()).unwrap();
        });
        assert!(matches!(
            joined_rx.recv_timeout(Duration::from_millis(30)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        resume_tx.send(()).unwrap();
        joined_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        joining.join().unwrap();
        assert!(
            entered_rx.try_recv().is_err(),
            "queued HWND was reused after stop"
        );
    }

    #[test]
    fn already_stopped_worker_never_dispatches_a_queued_operation() {
        struct CountingStrategy(Arc<Mutex<usize>>);
        impl TaskbarStrategy for CountingStrategy {
            fn init(&mut self) -> bool {
                true
            }
            fn embed_window(&self, _: HWND) -> bool {
                *self.0.lock().unwrap() += 1;
                true
            }
            fn update_layout(&mut self, _: LayoutParams) -> Option<TaskbarLayout> {
                *self.0.lock().unwrap() += 1;
                None
            }
            fn restore(&self) {}
        }
        let (tx, rx) = mpsc::channel();
        tx.send(TaskbarCommand::Update { width: 300 }).unwrap();
        tx.send(TaskbarCommand::Embed { hwnd_ptr: 100 }).unwrap();
        let calls = Arc::new(Mutex::new(0));
        let mut strategy: Option<Box<dyn TaskbarStrategy>> =
            Some(Box::new(CountingStrategy(calls.clone())));
        let callback: TaskbarLayoutCallback = Box::new(|_| panic!("stopped callback ran"));
        run_commands(&rx, &callback, &AtomicBool::new(true), &mut strategy);
        assert_eq!(*calls.lock().unwrap(), 0);
    }
}

fn create_strategy() -> Option<Box<dyn TaskbarStrategy>> {
    let build_num = get_windows_build_number();
    debug!("Windows 版本号: {build_num}");

    let (mut primary, mut secondary): (Box<dyn TaskbarStrategy>, Box<dyn TaskbarStrategy>) =
        if build_num >= 22000 {
            (
                Box::new(Win11Strategy::new()),
                Box::new(LegacyStrategy::new()),
            )
        } else {
            (
                Box::new(LegacyStrategy::new()),
                Box::new(Win11Strategy::new()),
            )
        };

    if primary.init() {
        debug!("首选策略初始化成功");
        return Some(primary);
    }

    warn!("首选策略失效，尝试备选策略");
    if secondary.init() {
        debug!("备选策略初始化成功");
        return Some(secondary);
    }

    error!("未检测到支持的任务栏结构");
    None
}

/// 用于关闭句柄的 RAII 包装器
struct EventHandle(HANDLE);

impl Drop for EventHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

// Safety: 跨线程访问句柄是安全的
unsafe impl Send for EventHandle {}
unsafe impl Sync for EventHandle {}

pub struct RegistryWatcher {
    stop_event: Arc<EventHandle>,
    is_running: Arc<AtomicBool>,
}

impl RegistryWatcher {
    /// 启动注册表监听
    ///
    /// 当 `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced`
    /// 下的值发生变化时，会调用传入的 Rust 回调函数，可以用它来监听任务栏的布局更改
    ///
    /// ## Errors
    /// 创建停止事件失败时抛出错误
    pub fn new<F>(callback: F) -> Result<Self>
    where
        F: Fn() + Send + Sync + 'static,
    {
        let raw_event = unsafe { CreateEventW(None, true, false, None) }
            .map_err(|e| anyhow!("创建停止事件失败: {e}"))?;

        let stop_event = Arc::new(EventHandle(raw_event));
        let is_running = Arc::new(AtomicBool::new(true));
        let thread_event = stop_event.clone();
        let callback: Arc<RegistryChangedCallback> = Arc::new(Box::new(callback));

        thread::spawn(move || unsafe {
            Self::watch_loop(&thread_event, &callback);
        });

        Ok(Self {
            stop_event,
            is_running,
        })
    }

    pub fn stop(&self) {
        if !self.is_running.load(Ordering::SeqCst) {
            return;
        }

        unsafe {
            let _ = SetEvent(self.stop_event.0);
        }

        self.is_running.store(false, Ordering::SeqCst);
        info!("注册表监听已停止");
    }

    unsafe fn watch_loop(
        stop_event_wrapper: &Arc<EventHandle>,
        callback: &Arc<RegistryChangedCallback>,
    ) {
        let stop_event = stop_event_wrapper.0;

        let mut h_key = HKEY::default();
        let sub_key = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced");

        unsafe {
            if RegOpenKeyExW(
                HKEY_CURRENT_USER,
                sub_key,
                Some(0),
                KEY_NOTIFY,
                &raw mut h_key,
            )
            .is_err()
            {
                error!("打开注册表键失败");
                return;
            }

            let reg_event = match CreateEventW(None, false, false, None) {
                Ok(evt) => evt,
                Err(e) => {
                    let _ = &e;
                    error!("创建注册表事件失败: {e}");
                    let _ = RegCloseKey(h_key);
                    return;
                }
            };

            loop {
                let notify_res = RegNotifyChangeKeyValue(
                    h_key,
                    true,
                    REG_NOTIFY_CHANGE_LAST_SET,
                    Some(reg_event),
                    true,
                );

                if notify_res.is_err() {
                    error!("注册通知失败");
                    break;
                }

                let handles = [stop_event, reg_event];
                let wait_result = WaitForMultipleObjects(&handles, false, INFINITE);

                let index = wait_result.0.wrapping_sub(WAIT_OBJECT_0.0);

                match index {
                    0 => {
                        debug!("退出监听循环");
                        break;
                    }
                    1 => {
                        callback();
                    }
                    _ => {
                        error!("WaitForMultipleObjects 返回异常或超时 {wait_result:?}");
                        break;
                    }
                }
            }

            let _ = CloseHandle(reg_event);
            let _ = RegCloseKey(h_key);
        }
    }
}

impl Drop for RegistryWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}
