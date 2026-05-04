import { resolve, sep } from "path";

const TENANT_CODE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ACTIVITY_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isValidTenantCode(code: string): boolean {
	return typeof code === "string" && TENANT_CODE_RE.test(code);
}

export function isValidActivityId(id: string): boolean {
	return typeof id === "string" && ACTIVITY_ID_RE.test(id);
}

export function normalizeActivityId(id: string): string {
	return id.toLowerCase();
}

/**
 * Resolve a path under base, refusing any segment that contains separators
 * or traversal sequences. Throws if the resolved path escapes base.
 */
export function resolveStoragePath(base: string, ...segments: string[]): string {
	for (const seg of segments) {
		if (typeof seg !== "string" || seg.length === 0) {
			throw new Error(`invalid path segment: ${JSON.stringify(seg)}`);
		}
		if (seg.includes("/") || seg.includes("\\") || seg === "." || seg === "..") {
			throw new Error(`path segment contains separator or traversal: ${seg}`);
		}
	}
	const baseResolved = resolve(base);
	const target = resolve(baseResolved, ...segments);
	const baseWithSep = baseResolved.endsWith(sep) ? baseResolved : baseResolved + sep;
	if (target !== baseResolved && !target.startsWith(baseWithSep)) {
		throw new Error(`path escapes base: ${target}`);
	}
	return target;
}
