import type { Node as SyntaxNode } from "web-tree-sitter";
import { parseALSource } from "./parser-init.js";
import { readFileSync } from "fs";
import { resolve, relative } from "path";
import type {
  SourceIndex,
  ALFileInfo,
  ObjectInfo,
  ProcedureInfo,
  TriggerInfo,
  ProcedureFeatures,
  LoopInfo,
  RecordOpInfo,
  RecordOpType,
  DangerousCallInfo,
} from "../types/source-index.js";

const RECORD_OPS: Set<string> = new Set([
  "findset",
  "findfirst",
  "findlast",
  "find",
  "get",
  "calcfields",
  "calcsums",
  "modify",
  "modifyall",
  "insert",
  "delete",
  "deleteall",
  "setloadfields",
  "setrange",
  "setfilter",
  "reset",
  "next",
  "count",
  "countapprox",
  "isempty",
]);

/** Map from canonical lowercase record op name to its properly-cased RecordOpType */
const RECORD_OP_CASE_MAP: Record<string, RecordOpType> = {
  findset: "FindSet",
  findfirst: "FindFirst",
  findlast: "FindLast",
  find: "Find",
  get: "Get",
  calcfields: "CalcFields",
  calcsums: "CalcSums",
  modify: "Modify",
  modifyall: "ModifyAll",
  insert: "Insert",
  delete: "Delete",
  deleteall: "DeleteAll",
  setloadfields: "SetLoadFields",
  setrange: "SetRange",
  setfilter: "SetFilter",
  reset: "Reset",
  next: "Next",
  count: "Count",
  countapprox: "CountApprox",
  isempty: "IsEmpty",
};

const OBJECT_TYPE_MAP: Record<string, string> = {
  codeunit_declaration: "Codeunit",
  table_declaration: "Table",
  page_declaration: "Page",
  report_declaration: "Report",
  query_declaration: "Query",
  xmlport_declaration: "XMLport",
  enum_declaration: "Enum",
  interface_declaration: "Interface",
  controladdin_declaration: "ControlAddIn",
  tableextension_declaration: "TableExtension",
  pageextension_declaration: "PageExtension",
  enumextension_declaration: "EnumExtension",
  reportextension_declaration: "ReportExtension",
  permissionset_declaration: "PermissionSet",
};

const LOOP_NODE_TYPES = new Set([
  "repeat_statement",
  "for_statement",
  "foreach_statement",
  "while_statement",
]);

const LOOP_TYPE_MAP: Record<string, LoopInfo["type"]> = {
  repeat_statement: "repeat",
  for_statement: "for",
  foreach_statement: "foreach",
  while_statement: "while",
};

const NESTING_NODE_TYPES = new Set([
  "repeat_statement",
  "for_statement",
  "foreach_statement",
  "while_statement",
  "if_statement",
  "case_statement",
]);

/**
 * Check if the lines preceding a node contain an [EventSubscriber] attribute.
 * Looks up to 5 lines before the node's start row.
 */
function checkEventSubscriber(lines: string[], nodeStartRow: number): boolean {
  const start = Math.max(0, nodeStartRow - 5);
  for (let i = start; i < nodeStartRow; i++) {
    if (/\[EventSubscriber\b/i.test(lines[i])) {
      return true;
    }
  }
  return false;
}

/**
 * Strip surrounding double quotes from a quoted_identifier node's text.
 */
function stripQuotes(text: string): string {
  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * Find the object declaration node in the source file root.
 */
function findObjectDeclaration(
  root: SyntaxNode,
): SyntaxNode | null {
  for (const child of root.namedChildren) {
    if (child.type in OBJECT_TYPE_MAP) {
      return child;
    }
  }
  return null;
}

/**
 * Extract object ID from the declaration node.
 * The ID is the first integer child.
 */
function extractObjectId(decl: SyntaxNode): number {
  for (const child of decl.namedChildren) {
    if (child.type === "integer") {
      return parseInt(child.text, 10);
    }
  }
  return 0;
}

/**
 * Extract object name from the declaration node.
 * The name can be an identifier or quoted_identifier.
 */
function extractObjectName(decl: SyntaxNode): string {
  for (const child of decl.namedChildren) {
    if (child.type === "quoted_identifier") {
      return stripQuotes(child.text);
    }
    if (child.type === "identifier") {
      return child.text;
    }
  }
  return "";
}

/**
 * Extract procedure name from a procedure node.
 */
function extractProcedureName(proc: SyntaxNode): string {
  const nameNode = proc.childForFieldName("name");
  if (nameNode) {
    // The name field contains a `name` node with an identifier child
    for (const child of nameNode.namedChildren) {
      if (child.type === "identifier") {
        return child.text;
      }
    }
    return nameNode.text;
  }
  return "";
}

/**
 * Extract trigger name from a named_trigger or trigger_declaration node.
 * For named_trigger, the name is embedded as a keyword in the grammar text.
 * For trigger_declaration, it may have a name field.
 */
function extractTriggerName(trigger: SyntaxNode): string {
  // Try field-based access first (trigger_declaration)
  const nameNode = trigger.childForFieldName("name");
  if (nameNode) {
    return stripQuotes(nameNode.text);
  }

  // For named_trigger, extract from text: "trigger OnInsert()" -> "OnInsert"
  const firstLine = trigger.text.split("\n")[0];
  const match = firstLine.match(/trigger\s+(\w+)/i);
  if (match) {
    return match[1];
  }

  // For onrun_trigger
  if (trigger.type === "onrun_trigger") {
    return "OnRun";
  }

  return "";
}

/**
 * Find the code_block child of a procedure or trigger node.
 */
function findCodeBlock(node: SyntaxNode): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child.type === "code_block") {
      return child;
    }
  }
  return null;
}

/**
 * Recursively compute the maximum nesting depth of control flow in a node.
 */
function computeNestingDepth(node: SyntaxNode): number {
  let maxDepth = 0;

  for (const child of node.namedChildren) {
    if (NESTING_NODE_TYPES.has(child.type)) {
      const childDepth = 1 + computeNestingDepth(child);
      if (childDepth > maxDepth) {
        maxDepth = childDepth;
      }
    } else {
      const childDepth = computeNestingDepth(child);
      if (childDepth > maxDepth) {
        maxDepth = childDepth;
      }
    }
  }

  return maxDepth;
}

/**
 * Check if a node is a descendant of another node.
 */
function isDescendantOf(node: SyntaxNode, ancestor: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (current.id === ancestor.id) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Collect all loop nodes within a subtree.
 */
function collectLoopNodes(node: SyntaxNode): SyntaxNode[] {
  const loops: SyntaxNode[] = [];

  function walk(n: SyntaxNode) {
    if (LOOP_NODE_TYPES.has(n.type)) {
      loops.push(n);
    }
    for (const child of n.namedChildren) {
      walk(child);
    }
  }

  walk(node);
  return loops;
}

/**
 * Collect all record operation call_expression nodes within a subtree.
 * Returns [node, methodName, recordVariable] tuples.
 */
function collectRecordOps(
  node: SyntaxNode,
): Array<{ node: SyntaxNode; methodName: string; recordVariable: string }> {
  const ops: Array<{
    node: SyntaxNode;
    methodName: string;
    recordVariable: string;
  }> = [];

  function walk(n: SyntaxNode) {
    if (n.type === "call_expression") {
      const funcNode = n.childForFieldName("function") ?? n.namedChildren[0];
      if (funcNode) {
        if (funcNode.type === "member_expression") {
          const objNode = funcNode.childForFieldName("object") ?? funcNode.namedChildren[0];
          const propNode = funcNode.childForFieldName("property") ?? funcNode.namedChildren[1];
          if (propNode) {
            const methodName = stripQuotes(propNode.text);
            if (RECORD_OPS.has(methodName.toLowerCase())) {
              ops.push({
                node: n,
                methodName,
                recordVariable: objNode ? objNode.text : "",
              });
            }
          }
        } else if (funcNode.type === "field_access") {
          // Rec."Field Name"() style
          const recordNode = funcNode.childForFieldName("record") ?? funcNode.namedChildren[0];
          const fieldNode = funcNode.childForFieldName("field") ?? funcNode.namedChildren[1];
          if (fieldNode) {
            const methodName = stripQuotes(fieldNode.text);
            if (RECORD_OPS.has(methodName.toLowerCase())) {
              ops.push({
                node: n,
                methodName,
                recordVariable: recordNode ? recordNode.text : "",
              });
            }
          }
        }
      }
    }

    for (const child of n.namedChildren) {
      walk(child);
    }
  }

  walk(node);
  return ops;
}

const DANGEROUS_CALLS = new Set(["commit", "error", "testfield"]);

const DANGEROUS_CALL_CASE_MAP: Record<string, DangerousCallInfo["type"]> = {
  commit: "Commit",
  error: "Error",
  testfield: "TestField",
};

/**
 * Collect dangerous call_expression nodes (Commit, Error, TestField) within a subtree.
 */
function collectDangerousCalls(
  node: SyntaxNode,
): Array<{ node: SyntaxNode; callType: DangerousCallInfo["type"] }> {
  const calls: Array<{ node: SyntaxNode; callType: DangerousCallInfo["type"] }> = [];

  function walk(n: SyntaxNode) {
    if (n.type === "call_expression") {
      const funcNode = n.childForFieldName("function") ?? n.namedChildren[0];
      if (funcNode) {
        const name = funcNode.text.toLowerCase();
        if (DANGEROUS_CALLS.has(name)) {
          calls.push({ node: n, callType: DANGEROUS_CALL_CASE_MAP[name] });
        }
      }
    }
    for (const child of n.namedChildren) {
      walk(child);
    }
  }

  walk(node);
  return calls;
}

/**
 * Extract structural features (loops, record ops, nesting) from a code_block node.
 */
function extractFeatures(codeBlock: SyntaxNode | null): ProcedureFeatures {
  if (!codeBlock) {
    return {
      loops: [],
      recordOps: [],
      recordOpsInLoops: [],
      dangerousCallsInLoops: [],
      nestingDepth: 0,
    };
  }

  // Collect loops
  const loopNodes = collectLoopNodes(codeBlock);
  const loops: LoopInfo[] = loopNodes.map((ln) => ({
    type: LOOP_TYPE_MAP[ln.type],
    lineStart: ln.startPosition.row + 1, // Convert 0-based to 1-based
    lineEnd: ln.endPosition.row + 1,
  }));

  // Collect record ops
  const rawOps = collectRecordOps(codeBlock);
  const recordOps: RecordOpInfo[] = [];
  const recordOpsInLoops: RecordOpInfo[] = [];

  for (const op of rawOps) {
    const insideLoop = loopNodes.some((ln) => isDescendantOf(op.node, ln));
    const opInfo: RecordOpInfo = {
      type: RECORD_OP_CASE_MAP[op.methodName.toLowerCase()],
      line: op.node.startPosition.row + 1,
      column: op.node.startPosition.column,
      insideLoop,
      recordVariable: op.recordVariable || undefined,
    };
    recordOps.push(opInfo);
    if (insideLoop) {
      recordOpsInLoops.push(opInfo);
    }
  }

  // Collect dangerous calls (Commit, Error, TestField)
  const rawDangerousCalls = collectDangerousCalls(codeBlock);
  const dangerousCallsInLoops: DangerousCallInfo[] = [];
  for (const dc of rawDangerousCalls) {
    const insideLoop = loopNodes.some((ln) => isDescendantOf(dc.node, ln));
    if (insideLoop) {
      dangerousCallsInLoops.push({
        type: dc.callType,
        line: dc.node.startPosition.row + 1,
        column: dc.node.startPosition.column,
        insideLoop: true,
      });
    }
  }

  // Compute nesting depth
  const nestingDepth = computeNestingDepth(codeBlock);

  return { loops, recordOps, recordOpsInLoops, dangerousCallsInLoops, nestingDepth };
}

/**
 * Parse a single AL file and return its ObjectInfo.
 */
export async function indexALFile(
  absolutePath: string,
  baseDir: string,
): Promise<ObjectInfo | null> {
  let source: string;
  try {
    source = readFileSync(absolutePath, "utf-8");
  } catch {
    return null;
  }

  const sourceLines = source.split("\n");
  const tree = await parseALSource(source);
  const root = tree.rootNode;

  const declNode = findObjectDeclaration(root);
  if (!declNode) {
    return null;
  }

  const objectType = OBJECT_TYPE_MAP[declNode.type];
  const objectId = extractObjectId(declNode);
  const objectName = extractObjectName(declNode);
  const relativePath = relative(baseDir, absolutePath).replace(/\\/g, "/");

  const fileInfo: ALFileInfo = {
    relativePath,
    absolutePath,
    objectType,
    objectName,
    objectId,
  };

  const procedures: ProcedureInfo[] = [];
  const triggers: TriggerInfo[] = [];

  // Walk children of the declaration node to find procedures and triggers
  function walkForMembers(node: SyntaxNode) {
    for (const child of node.namedChildren) {
      if (child.type === "procedure") {
        const name = extractProcedureName(child);
        const codeBlock = findCodeBlock(child);
        const features = extractFeatures(codeBlock);

        procedures.push({
          name,
          objectType,
          objectName,
          objectId,
          file: relativePath,
          lineStart: child.startPosition.row + 1,
          lineEnd: child.endPosition.row + 1,
          features,
          isEventSubscriber: checkEventSubscriber(sourceLines, child.startPosition.row),
        });
      } else if (
        child.type === "named_trigger" ||
        child.type === "trigger_declaration"
      ) {
        const name = extractTriggerName(child);
        const codeBlock = findCodeBlock(child);
        const features = extractFeatures(codeBlock);

        triggers.push({
          name,
          objectType,
          objectName,
          objectId,
          file: relativePath,
          lineStart: child.startPosition.row + 1,
          lineEnd: child.endPosition.row + 1,
          features,
        });
      } else if (child.type === "onrun_trigger") {
        const codeBlock = findCodeBlock(child);
        const features = extractFeatures(codeBlock);

        triggers.push({
          name: "OnRun",
          objectType,
          objectName,
          objectId,
          file: relativePath,
          lineStart: child.startPosition.row + 1,
          lineEnd: child.endPosition.row + 1,
          features,
        });
      } else {
        // Recurse into other container nodes (e.g., fields, keys, etc.)
        walkForMembers(child);
      }
    }
  }

  walkForMembers(declNode);

  return {
    objectType,
    objectName,
    objectId,
    file: fileInfo,
    procedures,
    triggers,
  };
}

/**
 * Recursively find all .al files in a directory.
 */
async function findALFiles(dirPath: string): Promise<string[]> {
  const { Glob } = await import("bun");
  const glob = new Glob("**/*.al");
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: dirPath, absolute: true })) {
    files.push(file);
  }
  return files;
}

/**
 * Build a source index from a directory of AL files.
 */
export async function buildSourceIndex(dirPath: string): Promise<SourceIndex> {
  const alFiles = await findALFiles(dirPath);

  const index: SourceIndex = {
    files: [],
    procedures: new Map(),
    triggers: new Map(),
    objects: new Map(),
  };

  for (const filePath of alFiles) {
    const objectInfo = await indexALFile(filePath, dirPath);
    if (!objectInfo) continue;

    index.files.push(objectInfo.file);

    const objectKey = `${objectInfo.objectType}_${objectInfo.objectId}`;
    index.objects.set(objectKey, objectInfo);

    for (const proc of objectInfo.procedures) {
      const key = proc.name.toLowerCase();
      const existing = index.procedures.get(key) ?? [];
      existing.push(proc);
      index.procedures.set(key, existing);
    }

    for (const trigger of objectInfo.triggers) {
      const key = trigger.name.toLowerCase();
      const existing = index.triggers.get(key) ?? [];
      existing.push(trigger);
      index.triggers.set(key, existing);
    }
  }

  return index;
}
