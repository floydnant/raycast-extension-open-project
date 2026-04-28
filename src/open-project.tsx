import { Action, ActionPanel, Icon, List } from "@raycast/api";
import { showFailureToast, useCachedPromise } from "@raycast/utils";
import { UseCachedPromiseReturnType } from "@raycast/utils/dist/types";
import { exec } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { z } from "zod";
import { stripJsonComments } from "./strip-json-comments.util";
import { entriesOf } from "./utils";

const home = os.homedir();

// @TODO: this should be configurable
const configFolderName = ".flo-cli";
const configFileName = "flo-cli.jsonc";
const configFolderPath = path.join(home, ".config", configFolderName);
const configFilePath = path.join(configFolderPath, configFileName);

// @TODO: this should be configurable
const baseProjectPath = `${home}/coding/`;

export const fixBranchName = (branch: string) =>
  branch.replace("refs/", "").replace("heads/", "").replace("remotes/", "").replace("origin/", "");

export interface Worktree {
  directory: string;
  isMainWorktree: boolean;

  branch?: string;
  head?: string;
  isDetached?: boolean;
  isLocked?: boolean;
  lockReason?: string;
  isPrunable?: boolean;
  prunableReason?: string;
  isBare?: boolean;
}

const parseWorktreeList = (projectRoot: string, rawOutput: string) => {
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
    const prunableReason = block.match(/^prunable .+/m)?.[0].replace("locked ", "");

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
      isMainWorktree: projectRoot == directory,
    } satisfies Worktree;
  });

  return worktrees;
};

const configSchema = z.object({
  projectsDirs: z.string().array().optional(),
  projects: z.record(z.string(), z.object({ root: z.string() })),
});

type ProjectDirectory = {
  directory: string;
  name: string;
  branch: string | null;
  getSubProjects: (() => Promise<(ProjectDirectory & { isDirty: boolean })[]>) | null;
  subProjects?: (ProjectDirectory & { isDirty: boolean })[];
};

const getProjects = async (): Promise<ProjectDirectory[] | null> => {
  const rawConfigFile = await fs.readFile(configFilePath, "utf-8").catch(() => null);
  if (!rawConfigFile) return null;

  const strippedConfig = stripJsonComments(rawConfigFile, { trailingCommas: true });
  const parsedConfig = strippedConfig && JSON.parse(strippedConfig);
  const validationResult = configSchema.safeParse(parsedConfig);
  if (validationResult.error)
    showFailureToast(validationResult.error, {
      title: "Failed to read config file",
      message: `Check if a file exists at ${configFilePath}`,
    });

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

  const projects = validationResult.success
    ? await Promise.all(
        projectFolderEntries.map(async ([name, config]) => {
          const getSubProjects = async () => {
            const rawWorktreeListOutput = await new Promise<string>((res, rej) =>
              exec(`git worktree list --porcelain`, { cwd: config.root }, (err, stdout) =>
                err ? rej(err) : res(stdout),
              ),
            ).catch(() => "");
            const worktrees = parseWorktreeList(config.root, rawWorktreeListOutput);

            if (worktrees.length == 0) {
              return [
                {
                  name,
                  directory: config.root,
                  getSubProjects: null,
                  branch: "not a git repository",
                  isDirty: false,
                },
              ];
            }

            return await Promise.all(
              worktrees.map(async (worktree) => {
                const isDirty = await new Promise<boolean>((res, rej) =>
                  exec(`git status --short`, { cwd: worktree.directory }, (err, stdout) => {
                    if (err) rej(err);
                    else res(stdout ? true : false);
                  }),
                ).catch(() => false);

                return {
                  name: worktree.branch || worktree.head || "Bare",
                  directory: worktree.directory,
                  getSubProjects: null,
                  branch: worktree.branch || worktree.head || "Bare",
                  isDirty,
                };
              }),
            );
          };
          const subprojects = await getSubProjects();

          return {
            name,
            directory: config.root,
            getSubProjects: () => Promise.resolve(subprojects),
            subProjects: subprojects,
            branch: null,
          } satisfies ProjectDirectory;
        }),
      )
    : [];

  return projects;
};

const getProjectActions = ({ project }: { project: ProjectDirectory }) => {
  return [
    <Action.Open
      title="Open with Code"
      icon={Icon.Code}
      application={"/Applications/Visual Studio Code.app"}
      target={project.directory}
    ></Action.Open>,
    <Action.OpenWith title="Open With…" path={project.directory}></Action.OpenWith>,
    <Action.Open title="Show in Finder" application={"Finder"} target={project.directory}></Action.Open>,
    <Action.CopyToClipboard
      title="Copy Folder Path"
      shortcut={{ key: "c", modifiers: ["cmd"] }}
      content={project.directory}
    ></Action.CopyToClipboard>,
    <>
      {project.branch ? (
        <Action.CopyToClipboard
          title="Copy Branch"
          shortcut={{ key: "c", modifiers: ["cmd", "shift"] }}
          content={project.branch}
        ></Action.CopyToClipboard>
      ) : (
        <></>
      )}
    </>,
  ];
};

const ProjectList = ({
  projectsResult,
}: {
  projectsResult: Pick<UseCachedPromiseReturnType<ProjectDirectory[] | null, undefined>, "isLoading" | "data">;
}) => {
  const flatProjects = projectsResult?.data?.flatMap((project) => {
    return (
      project.subProjects?.map<ProjectDirectory & { isMainWorktree: boolean; isDirty: boolean }>((subProject) => ({
        name: project.name,
        directory: subProject.directory,
        branch: subProject.branch,
        isMainWorktree: project.directory == subProject.directory,
        getSubProjects: null,
        isDirty: subProject.isDirty,
      })) || []
    );
  });

  return (
    <List isLoading={projectsResult?.isLoading}>
      {flatProjects?.length ? (
        flatProjects.map((project) => (
          <List.Item
            key={project.name + project.directory}
            title={project.name.replace(/_|-/g, " ") + (project.isDirty ? " 🚧" : "")}
            subtitle={`<${project.branch}>   ${project.directory.replace(baseProjectPath, "")}`}
            keywords={[
              project.name,
              ...(project.branch?.split(/\W|_/) || []),
              project.branch || "",
              ...project.directory.replace(baseProjectPath, "").split("/"),
            ]}
            actions={<ActionPanel>{...getProjectActions({ project })}</ActionPanel>}
          />
        ))
      ) : (
        <List.EmptyView title="No Projects" description={`Try and add some to the config file at ${configFilePath}`} />
      )}
    </List>
  );
};

export default function Command() {
  const projectsResult = useCachedPromise(getProjects);

  return <ProjectList projectsResult={projectsResult} />;
}
