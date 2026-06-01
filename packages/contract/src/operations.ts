import type { z } from "zod";
import { ops as sandbox } from "../../../modules/sandbox/operations";
import { ops as filesystem } from "../../../modules/filesystem/operations";
import { ops as account } from "../../../modules/account/operations";
import { ops as agent } from "../../../modules/agent/operations";

// The registry = the merge of every capability module's ops slice. Add a capability by adding
// its module folder + one import/spread here. Everything else derives from this.
export const operations = {
  ...sandbox, ...filesystem, ...account, ...agent,
};

export type Operations = typeof operations;
export type OperationId = keyof Operations;
export type Input<K extends OperationId> = z.infer<Operations[K]["input"]>;
export type Output<K extends OperationId> = z.infer<Operations[K]["output"]>;
