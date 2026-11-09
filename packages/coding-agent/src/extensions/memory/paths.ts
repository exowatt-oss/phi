import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { projectDirName } from "../../core/project-dir-name.ts";
import { resolvePath } from "../../utils/paths.ts";

export function getMemoryDir(cwd: string, agentDir: string = getAgentDir()): string {
	return join(agentDir, "memory", projectDirName(resolvePath(cwd)));
}
