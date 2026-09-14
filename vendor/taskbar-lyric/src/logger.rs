#[cfg(feature = "tracing")]
#[macro_export]
macro_rules! trace {
    ($($arg:tt)*) => {
        tracing::trace!($($arg)*);
    };
}

#[cfg(not(feature = "tracing"))]
#[macro_export]
macro_rules! trace {
    ($($arg:tt)*) => {{};};
}

#[cfg(feature = "tracing")]
#[macro_export]
macro_rules! debug {
    ($($arg:tt)*) => {
        tracing::debug!($($arg)*);
    };
}

#[cfg(not(feature = "tracing"))]
#[macro_export]
macro_rules! debug {
    ($($arg:tt)*) => {{};};
}

#[cfg(feature = "tracing")]
#[macro_export]
macro_rules! info {
    ($($arg:tt)*) => {
        tracing::info!($($arg)*);
    };
}

#[cfg(not(feature = "tracing"))]
#[macro_export]
macro_rules! info {
    ($($arg:tt)*) => {{};};
}

#[cfg(feature = "tracing")]
#[macro_export]
macro_rules! warn {
    ($($arg:tt)*) => {
        tracing::warn!($($arg)*);
    };
}

#[cfg(not(feature = "tracing"))]
#[macro_export]
macro_rules! warn {
    ($($arg:tt)*) => {{};};
}

#[cfg(feature = "tracing")]
#[macro_export]
macro_rules! error {
    ($($arg:tt)*) => {
        tracing::error!($($arg)*);
    };
}

#[cfg(not(feature = "tracing"))]
#[macro_export]
macro_rules! error {
    ($($arg:tt)*) => {{};};
}
