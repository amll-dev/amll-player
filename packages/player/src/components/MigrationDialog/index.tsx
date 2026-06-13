import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import {
	Box,
	Button,
	Callout,
	Checkbox,
	Dialog,
	Flex,
	Progress,
	Text,
} from "@radix-ui/themes";
import { type FC, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MigrationState } from "../../hooks/useMigration";

interface MigrationDialogProps {
	state: MigrationState;
	onStart: () => void;
	onSkip: (opts?: { persist?: boolean; deleteOld?: boolean }) => void;
	onDeleteOld: () => void;
	onDismiss: () => void;
}

export const MigrationDialog: FC<MigrationDialogProps> = ({
	state,
	onStart,
	onSkip,
	onDeleteOld,
	onDismiss,
}) => {
	const { t } = useTranslation();
	const { status, progress, totalSongs, totalPlaylists, fatalError } = state;
	const [dontAskAgain, setDontAskAgain] = useState(false);
	const [deleteOldDataOnSkip, setDeleteOldDataOnSkip] = useState(false);
	const isOpen =
		status === "prompt" ||
		status === "migrating" ||
		status === "completed" ||
		status === "failed";

	if (!isOpen) return null;

	const showProgress = status === "migrating" && progress;
	const progressPercent = showProgress
		? progress.total > 0
			? Math.min(
					100,
					Math.max(0, Math.round((progress.current / progress.total) * 100)),
				)
			: 0
		: 0;

	return (
		<Dialog.Root open={isOpen}>
			<Dialog.Content
				onPointerDownOutside={(e) => e.preventDefault()}
				onEscapeKeyDown={(e) => e.preventDefault()}
			>
				{status === "prompt" && (
					<>
						<Dialog.Title>{t("amll.migrationDialog.title")}</Dialog.Title>
						<Dialog.Description size="2">
							{t("amll.migrationDialog.description")}
						</Dialog.Description>

						<Box my="4">
							<Text as="div" size="2" color="gray">
								{t("amll.migrationDialog.summary", {
									songs: totalSongs,
									playlists: totalPlaylists,
								})}
							</Text>
						</Box>

						<Box mb="3">
							<Text as="label" size="2">
								<Flex gap="2" align="center">
									<Checkbox
										checked={dontAskAgain}
										onCheckedChange={(v) => setDontAskAgain(!!v)}
									/>
									{t("amll.migrationDialog.dontAskAgain")}
								</Flex>
							</Text>
						</Box>

						{dontAskAgain && (
							<Box mb="3">
								<Text as="label" size="2">
									<Flex gap="2" align="center">
										<Checkbox
											checked={deleteOldDataOnSkip}
											onCheckedChange={(v) => setDeleteOldDataOnSkip(!!v)}
										/>
										{t("amll.migrationDialog.deleteOldDataOnSkip")}
									</Flex>
								</Text>
							</Box>
						)}

						<Flex gap="3" justify="end">
							<Button
								variant="soft"
								color="gray"
								onClick={() =>
									onSkip({
										persist: dontAskAgain,
										deleteOld: dontAskAgain && deleteOldDataOnSkip,
									})
								}
							>
								{t("amll.migrationDialog.skip")}
							</Button>
							<Button onClick={onStart}>
								{t("amll.migrationDialog.start")}
							</Button>
						</Flex>
					</>
				)}

				{status === "migrating" && (
					<>
						<Dialog.Title>{t("amll.migrationDialog.title")}</Dialog.Title>
						<Dialog.Description size="2">
							{progress?.phase === "songs" &&
								t("amll.migrationDialog.phaseSongs")}
							{progress?.phase === "playlists" &&
								t("amll.migrationDialog.phasePlaylists")}
							{progress?.phase === "done" &&
								t("amll.migrationDialog.phaseDone")}
							{!progress && t("amll.migrationDialog.preparing")}
						</Dialog.Description>

						<Callout.Root color="amber" size="1" my="3">
							<Callout.Icon>
								<ExclamationTriangleIcon />
							</Callout.Icon>
							<Callout.Text>
								{t("amll.migrationDialog.doNotClose")}
							</Callout.Text>
						</Callout.Root>

						<Box my="4">
							<Progress value={progressPercent} />
							<Text as="div" size="2" color="gray" mt="2">
								{progress?.phase === "songs" &&
									t("amll.migrationDialog.progressSongs", {
										current: progress.current,
										total: progress.total,
									})}
								{progress?.phase === "playlists" &&
									t("amll.migrationDialog.progressPlaylists", {
										current: progress.current,
										total: progress.total,
									})}
								{progress && progress.failed > 0 && (
									<Text color="orange">
										{" "}
										{t("amll.migrationDialog.failedItems", {
											count: progress.failed,
										})}
									</Text>
								)}
							</Text>
						</Box>
					</>
				)}

				{status === "failed" && (
					<>
						<Dialog.Title>{t("amll.migrationDialog.failedTitle")}</Dialog.Title>
						<Dialog.Description size="2">
							{t("amll.migrationDialog.failedDesc")}
						</Dialog.Description>

						<Box my="3">
							{fatalError && (
								<Text as="div" size="2" color="red">
									{fatalError}
								</Text>
							)}
							{progress && progress.errors.length > 0 && (
								<ul style={{ margin: "4px 0", paddingLeft: "20px" }}>
									{progress.errors.map((err) => (
										<li key={err}>
											<Text size="2">{err}</Text>
										</li>
									))}
								</ul>
							)}
						</Box>

						<Text as="div" size="2" color="gray" mb="3">
							{t("amll.migrationDialog.failedRetryHint")}
						</Text>

						<Flex gap="3" justify="end">
							<Button onClick={onDismiss}>{t("common.dialog.confirm")}</Button>
						</Flex>
					</>
				)}

				{status === "completed" && (
					<>
						<Dialog.Title>
							{t("amll.migrationDialog.completedTitle")}
						</Dialog.Title>
						<Dialog.Description size="2">
							{progress
								? progress.failed > 0
									? t("amll.migrationDialog.completedDescWithFailures", {
											count: progress.imported,
											failed: progress.failed,
										})
									: t("amll.migrationDialog.completedDesc", {
											count: progress.imported,
										})
								: t("amll.migrationDialog.completedDescDefault")}
						</Dialog.Description>

						<Box my="4">
							<Text as="div" size="2" color="gray">
								{t("amll.migrationDialog.deleteOldDataLabel")}
							</Text>
						</Box>

						{progress && progress.errors.length > 0 && (
							<Callout.Root color="orange" size="1" mb="3">
								<Callout.Icon>
									<ExclamationTriangleIcon />
								</Callout.Icon>
								<Box>
									<Text as="div" size="2" weight="bold">
										{t("amll.migrationDialog.errorListTitle")}
									</Text>
									{progress.errors.map((err) => (
										<Text as="div" size="1" key={err}>
											{err}
										</Text>
									))}
								</Box>
							</Callout.Root>
						)}

						<Flex gap="3" justify="end">
							<Button variant="soft" color="gray" onClick={onDismiss}>
								{t("amll.migrationDialog.keepOldData")}
							</Button>
							<Button color="red" onClick={onDeleteOld}>
								{t("amll.migrationDialog.deleteOldData")}
							</Button>
						</Flex>
					</>
				)}
			</Dialog.Content>
		</Dialog.Root>
	);
};
