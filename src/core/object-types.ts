const OBJECT_TYPE_MAP: Record<number, string> = {
  0: "System",
  1: "Table",
  3: "Report",
  5: "CodeUnit",
  6: "XMLPort",
  8: "Page",
  9: "Query",
  14: "PageExtension",
  16: "TableExtension",
  17: "EnumExtension",
};

export function normalizeObjectType(objectType: string | number | undefined): string {
  if (objectType === undefined || objectType === null) return "";
  if (typeof objectType === "string") return objectType;
  return OBJECT_TYPE_MAP[objectType] ?? `Unknown(${objectType})`;
}
