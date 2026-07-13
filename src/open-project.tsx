import { Action, ActionPanel, Alert, confirmAlert, Icon, List, showToast, Toast, trash, Detail } from "@raycast/api";
import { showFailureToast, useCachedPromise } from "@raycast/utils";
import { exec } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { z } from "zod";
import { stripJsonComments } from "./strip-json-comments.util";
import { entriesOf, valuesOf } from "./utils";

const home = os.homedir();

// @TODO: this should be configurable
const configFolderName = ".flo-cli";
const configFileName = "flo-cli.jsonc";
const configFolderPath = path.join(home, ".config", configFolderName);
const configFilePath = path.join(configFolderPath, configFileName);

export const fixBranchName = (branch: string) =>
  branch.replace("refs/", "").replace("heads/", "").replace("remotes/", "").replace("origin/", "");

export interface Worktree {
  directory: string;
  isMainWorktree: boolean;
  mainWorktreeDirectory: string;

  branch?: string;
  head?: string;
  isDetached?: boolean;
  isLocked?: boolean;
  lockReason?: string;
  isPrunable?: boolean;
  prunableReason?: string;
  isBare?: boolean;
}

const parseWorktreeList = (gitDir: string, rawOutput: string) => {
  const mainWorktreeDir = gitDir.split("/.git")[0];
  const worktreeTextBlocks = rawOutput.split("\n\n").filter(Boolean);

  const worktrees = worktreeTextBlocks.map((block) => {
    const directory = block.match(/(^worktree .+)/m)?.[0].replace("worktree ", "");
    const branch = block.match(/^branch .+/m)?.[0].replace("branch ", "");
    const isBare = /^bare/m.test(block);

    const head = block.match(/^HEAD .+/m)?.[0].replace("HEAD ", "");
    const isDetached = /^detached/m.test(block);

    const isLocked = /^locked/m.test(block);
    const lockReason = block.match(/^locked .+/m)?.[0].replace("locked ", "");

    const isPrunable = /^prunable/m.test(block);
    const prunableReason = block.match(/^prunable .+/m)?.[0].replace("prunable ", "");

    // this should never happen, because a worktree always has a directory
    if (!directory) {
      throw new Error(`Couldn't match a directory in:\n${block}`);
    }
    return {
      directory,
      branch: branch && fixBranchName(branch),
      head,
      isBare,
      isLocked,
      lockReason,
      isDetached,
      isPrunable,
      prunableReason,
      isMainWorktree: mainWorktreeDir == directory,
      mainWorktreeDirectory: mainWorktreeDir,
    } satisfies Worktree;
  });

  return worktrees;
};

const configSchema = z.object({
  projectsDirs: z.string().array().optional(),
  projects: z.record(z.string(), z.object({ root: z.string() })),
  stripRoots: z.string().array().optional(),
});

type RemoteGitUrl = {
  gitUrl?: string;
  httpUrl: string;
};

type ProjectWorktree = {
  directory: string;
  branch: string;
  isDirty: boolean | null;
  gitStatus: string | null;
  isMainWorktree: boolean;
  isGitRepo: boolean;
  mainWorktreeDirectory: string;
};
type ProjectDirectory = ProjectWorktree & {
  name: string;
  remoteUrl: RemoteGitUrl | null;
};

const cleanProjectDirectoryDisplay = (directory: string, stripRoots: string[]) => {
  let cleanedDirectory = directory;
  for (const root of stripRoots) {
    if (cleanedDirectory.startsWith(root)) {
      cleanedDirectory = cleanedDirectory.replace(root, "").replace(/^\//, "");
      break;
    }
  }
  return cleanedDirectory.replace(home, "~");
};

const getRemoteGitUrl = async (directory: string): Promise<RemoteGitUrl | null> => {
  const url = await new Promise<string | null>((res) =>
    exec(`git config --get remote.origin.url`, { cwd: directory }, (err, stdout) => {
      if (err) res(null);
      else res(stdout.trim());
    }),
  )
    .then((remoteUrl) => remoteUrl)
    .catch(() => null);

  if (!url) return null;

  if (url.startsWith("http")) {
    return { httpUrl: url };
  }
  if (url.startsWith("git@")) {
    const [_, domain, path] = url.match(/git@(.+):(.+)\.git/) || [];
    if (!domain || !path) return null;
    return { gitUrl: url, httpUrl: `https://${domain}/${path}` };
  }

  return null;
};

const getProjectWorktrees = async (directory: string): Promise<ProjectWorktree[]> => {
  const [gitDir, rawWorktreeListOutput] = await Promise.all([
    new Promise<string>((res, rej) =>
      exec(`git rev-parse --absolute-git-dir`, { cwd: directory }, (err, stdout) => (err ? rej() : res(stdout.trim()))),
    ),
    new Promise<string>((res, rej) =>
      exec(`git worktree list --porcelain`, { cwd: directory }, (err, stdout) => (err ? rej(err) : res(stdout))),
    ),
  ]).catch(() => [null, null]);

  const worktrees = rawWorktreeListOutput ? parseWorktreeList(gitDir!, rawWorktreeListOutput) : [];
  if (worktrees.length == 0) {
    return [
      {
        directory: directory,
        branch: "not a git repository",
        isDirty: false,
        gitStatus: null,
        isMainWorktree: true,
        isGitRepo: false,
        mainWorktreeDirectory: directory,
      } satisfies ProjectWorktree,
    ];
  }

  const projectWorktrees = await Promise.all(
    worktrees.map(async (worktree) => {
      const [gitStatusStdout, exists] = await Promise.all([
        new Promise<string>((res, _rej) =>
          exec(`git status --short -u`, { cwd: worktree.directory }, (err, stdout) => {
            if (err) res("");
            else res(stdout);
          }),
        ).catch(() => ""),
        fs
          .stat(worktree.directory)
          .then(() => true)
          .catch(() => false),
      ]);
      const isDirty = gitStatusStdout.trim().length > 0 ? true : false;

      return {
        exists: exists,
        directory: worktree.directory,
        branch: worktree.branch || worktree.head || "Bare",
        gitStatus: gitStatusStdout.trimEnd(),
        isDirty: isDirty,
        isMainWorktree: worktree.isMainWorktree,
        isGitRepo: true,
        mainWorktreeDirectory: worktree.mainWorktreeDirectory,
      } satisfies ProjectWorktree & { exists: boolean };
    }),
  );

  return projectWorktrees.filter((worktree) => worktree.exists);
};

const readConfig = async (configPath: string) => {
  const rawConfigFile = await fs.readFile(configPath, "utf-8").catch((err) => {
    showFailureToast(err, {
      title: "Failed to read config file",
      message: `Check if a file exists at ${configPath}`,
    });
    return null;
  });
  if (!rawConfigFile) return null;

  const strippedConfig = stripJsonComments(rawConfigFile, { trailingCommas: true });
  let parsedConfig = null;
  try {
    parsedConfig = strippedConfig && JSON.parse(strippedConfig);
  } catch (err) {
    showFailureToast(err, {
      title: "Config file is invalid JSON",
      message: `Check the file at ${configPath}`,
    });
    return null;
  }

  const validationResult = configSchema.safeParse(parsedConfig);
  if (validationResult.error) {
    showFailureToast(validationResult.error, {
      title: "Config file is not valid according to schema",
      message: `Check the file at ${configPath}`,
    });

    return null;
  }

  const implicitProjectFolderEntries = await Promise.all(
    (validationResult.success ? validationResult.data.projectsDirs || [] : []).map(async (dir) => {
      const resolvedDir = path.resolve(dir);
      const entries = await fs.readdir(resolvedDir, { withFileTypes: true });
      const subfolders = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => [entry.name, { root: path.join(resolvedDir, entry.name) }] as const);

      return subfolders;
    }),
  ).then((arrays) => arrays.flat());
  const seenProjectRoots = new Set<string>();
  const projectFolderEntries = validationResult.success
    ? [...entriesOf(validationResult.data.projects), ...implicitProjectFolderEntries].filter(([_, config]) => {
        const root = path.normalize(config.root);
        if (seenProjectRoots.has(root)) {
          return false;
        } else {
          seenProjectRoots.add(root);
          return true;
        }
      })
    : [];
  const explicitProjectsMap = validationResult.success
    ? new Set(valuesOf(validationResult.data.projects).map((project) => project.root))
    : new Set<string>();

  return {
    projectFolderEntries,
    explicitProjectsMap,
    stripRoots: validationResult.data.stripRoots,
  };
};
type ConfigData = NonNullable<Awaited<ReturnType<typeof readConfig>>>;

const getProjects = async (configData: ConfigData): Promise<ProjectDirectory[] | null> => {
  const projects = await Promise.all(
    configData.projectFolderEntries.map(async ([projectName, config]) => {
      const [worktrees, remoteUrl] = await Promise.all([
        getProjectWorktrees(config.root),
        getRemoteGitUrl(config.root),
      ]);

      return {
        root: config.root,
        isMain: worktrees.find((worktree) => worktree.isMainWorktree)?.directory === config.root,
        worktrees: worktrees
          .filter((worktree) => worktree.isGitRepo || configData.explicitProjectsMap.has(config.root))
          .map((worktree) => ({
            name: projectName,
            remoteUrl,
            ...worktree,
          })),
      };
    }),
  );

  return projects
    .filter((project) => project.isMain)
    .map((project) => project.worktrees)
    .flat();
};

const ProjectActionPanel = ({
  project,
  onDelete,
  showGitStatus = true,
}: {
  project: ProjectDirectory;
  onDelete: (project: ProjectDirectory) => void;
  showGitStatus?: boolean;
}) => {
  return (
    <ActionPanel title={path.basename(project.directory)}>
      {/* TODO: make this dynamic: allow to open with any installed editor (check individually) */}
      <Action.Open
        title="Open with Code"
        icon={Icon.Code}
        application={"/Applications/Visual Studio Code.app"}
        target={project.directory}
      ></Action.Open>
      <Action.OpenWith title="Open With…" path={project.directory}></Action.OpenWith>
      <Action.ShowInFinder
        title="Reveal in Finder"
        path={project.directory}
        shortcut={{ key: "r", modifiers: ["cmd", "shift"] }}
      ></Action.ShowInFinder>

      {showGitStatus && (
        <Action.Push
          title="Git Status"
          icon={Icon.Eye}
          shortcut={{ key: "p", modifiers: ["ctrl"] }}
          target={
            <Detail
              navigationTitle="Git Status"
              actions={ProjectActionPanel({ project, onDelete, showGitStatus: false })}
              markdown={`
# ${path.basename(project.directory)} \`${project.branch}\`
${project.directory} ${project.isDirty ? " 🚧" : ""} ${project.isMainWorktree ? " 📍" : ""}
\`\`\`
${project.isDirty ? project.gitStatus : "--"}
\`\`\`
`}
            />
          }
        ></Action.Push>
      )}

      <>
        {project.remoteUrl && (
          <Action.OpenInBrowser
            title="Open Repository"
            url={project.remoteUrl.httpUrl}
            shortcut={{ key: "o", modifiers: ["cmd"] }}
          ></Action.OpenInBrowser>
        )}
      </>
      <Action.CopyToClipboard
        title="Copy Folder Path"
        shortcut={{ key: "c", modifiers: ["cmd"] }}
        content={project.directory}
      ></Action.CopyToClipboard>
      <>
        {project.isGitRepo ? (
          <Action.CopyToClipboard
            title="Copy Branch"
            shortcut={{ key: "c", modifiers: ["cmd", "shift"] }}
            content={project.branch}
          ></Action.CopyToClipboard>
        ) : (
          <></>
        )}
      </>
      <Action
        title="Delete"
        style={Action.Style.Destructive}
        icon={Icon.Trash}
        shortcut={{ key: "delete", modifiers: ["ctrl"] }}
        onAction={async () => {
          const isConfirmed = await confirmAlert({
            title: "Move to Trash",
            message: `Are you sure you want to delete ${path.basename(project.directory)}${project.isDirty ? " with UNSAVED CHANGES" : ""}?`,
            icon: Icon.Trash,
            dismissAction: {
              title: "Cancel",
            },
            primaryAction: {
              title: "Move to Trash",
              style: Alert.ActionStyle.Destructive,
              onAction() {},
            },
          });
          if (!isConfirmed) return;

          if (project.isMainWorktree) {
            // TODO: if it's the main worktree, ask to delete all worktrees
          }

          await trash(project.directory);

          if (project.isGitRepo && !project.isMainWorktree) {
            await new Promise((res, _rej) =>
              exec(
                `git worktree remove "${project.directory}"`,
                { cwd: project.mainWorktreeDirectory },
                (err, stdout, stderr) => {
                  if (err) {
                    console.error("Error removing worktree:", err, stderr);
                    res(false);
                  } else res(true);
                },
              ),
            );
          }

          showToast({
            style: Toast.Style.Success,
            title: "Moved to Trash",
            message: `${path.basename(project.directory)} has been moved to trash`,
          });
          onDelete(project);
        }}
      ></Action>
    </ActionPanel>
  );
};

export default function Command() {
  const projectsResult = useCachedPromise(async () => {
    const config = await readConfig(configFilePath);
    if (!config) return null;

    const projects = await getProjects(config);

    return { config, projects };
  });

  const projects = projectsResult?.data?.projects;
  const stripRoots = projectsResult?.data?.config?.stripRoots || [];

  return (
    <List isLoading={projectsResult?.isLoading}>
      {projects?.length ? (
        projects.map((project) => (
          <List.Item
            key={project.name + project.directory}
            title={
              project.name.replace(/_|-/g, " ") + (project.isDirty ? " 🚧" : "") + (project.isMainWorktree ? " 📍" : "")
            }
            subtitle={`<${project.branch}>   ${cleanProjectDirectoryDisplay(project.directory, stripRoots)}`}
            keywords={[
              project.name,
              ...(project.branch?.split(/\W|_/) || []),
              project.branch || "",
              ...cleanProjectDirectoryDisplay(project.directory, stripRoots).split("/"),
            ]}
            actions={<ProjectActionPanel project={project} onDelete={() => projectsResult.revalidate()} />}
          />
        ))
      ) : (
        <List.EmptyView title="No Projects" description={`Try and add some to the config file at ${configFilePath}`} />
      )}
    </List>
  );
}
