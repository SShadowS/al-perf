import type { Command } from "commander";
import { resolve } from "path";
import { sortPatterns } from "../../core/patterns.js";
import { SourceIndexCache } from "../../source/cache.js";
import { buildSourceIndex } from "../../source/indexer.js";
import { runSourceOnlyDetectors } from "../../source/source-only-patterns.js";
import {
	runSourceDetectors,
	syntheticMethodsFromIndex,
} from "../../source/source-patterns.js";
import type { DetectedPattern } from "../../types/patterns.js";

export interface SourceAnalysisResult {
	files: number;
	/** Files that threw while indexing — reported, never silently dropped. */
	failedFiles?: Array<{ path: string; reason: string }>;
	objects: Array<{
		objectType: string;
		objectName: string;
		objectId: number;
		file: string;
		procedureCount: number;
		triggerCount: number;
		eventSubscriberCount: number;
	}>;
	findings: DetectedPattern[];
	tableClusters: Array<{
		recordVariable: string;
		findingCount: number;
		findings: Array<{
			id: string;
			severity: string;
			title: string;
			procedure: string;
		}>;
	}>;
	summary: {
		totalObjects: number;
		totalProcedures: number;
		totalTriggers: number;
		totalEventSubscribers: number;
		findingCount: { critical: number; warning: number; info: number };
	};
}

/**
 * Build table clusters from findings.
 * Groups findings by record variable mentioned in evidence/description.
 */
function buildTableClusters(
	findings: DetectedPattern[],
): SourceAnalysisResult["tableClusters"] {
	const clusterMap = new Map<
		string,
		{
			findings: Array<{
				id: string;
				severity: string;
				title: string;
				procedure: string;
			}>;
		}
	>();

	for (const finding of findings) {
		// Extract record variable from the title — patterns like "FindSet without filters on Customer"
		const onMatch = finding.title.match(/\bon\s+(\w+)\b/i);
		const recVar = onMatch ? onMatch[1] : null;
		if (!recVar) continue;

		const key = recVar.toLowerCase();
		if (!clusterMap.has(key)) {
			clusterMap.set(key, { findings: [] });
		}
		clusterMap.get(key)!.findings.push({
			id: finding.id,
			severity: finding.severity,
			title: finding.title,
			procedure: finding.involvedMethods[0] ?? "",
		});
	}

	return Array.from(clusterMap.entries())
		.filter(([, cluster]) => cluster.findings.length >= 2)
		.map(([recVar, cluster]) => ({
			recordVariable: recVar,
			findingCount: cluster.findings.length,
			findings: cluster.findings,
		}))
		.sort((a, b) => b.findingCount - a.findingCount);
}

export function registerAnalyzeSourceCommand(program: Command) {
	program
		.command("analyze-source")
		.description(
			"Analyze AL source files for structural patterns (no profile needed)",
		)
		.argument("<source-dir>", "Path to directory containing .al source files")
		.option("-f, --format <format>", "Output format: text|json", "text")
		.option("--cache", "Cache source index for faster re-analysis")
		.action(async (sourceDir: string, opts: any) => {
			let index;
			if (opts.cache) {
				const cache = new SourceIndexCache(
					resolve(sourceDir, ".al-profile-cache"),
				);
				index = await cache.getOrBuild(sourceDir);
			} else {
				index = await buildSourceIndex(sourceDir);
			}
			const findings = runSourceOnlyDetectors(index);

			// Run the real source-correlated detectors (calcfields/modify/insert/
			// delete/record-op-in-loop, missing/incomplete-setloadfields) against
			// synthetic zero-impact methods built from the index itself. This used
			// to be a hand-rolled loop over recordOpsInLoops that minted its own
			// ids/severities straight from op.type -- drifting from the real
			// detectors (e.g. insert-in-loop/delete-in-loop always "info", Delete
			// included even on temporary records, no implicit-loop
			// self-explanation). Calling the real detectors means this surface can
			// never disagree with them again.
			const structuralFindings = runSourceDetectors(
				syntheticMethodsFromIndex(index),
				index,
			);

			// Every finding on this path carries impact: 0 — there is no profile,
			// so there is no measured time. sortPatterns falls back to severity,
			// then to id for a deterministic order (previously: severity only,
			// with no tiebreak, so equal-severity findings kept arbitrary array
			// order).
			const allFindings = sortPatterns([...findings, ...structuralFindings]);

			const tableClusters = buildTableClusters(allFindings);

			// Build summary
			let totalProcedures = 0;
			let totalTriggers = 0;
			let totalEventSubscribers = 0;

			const objectSummaries = Array.from(index.objects.values()).map((obj) => {
				const eventSubCount = obj.procedures.filter(
					(p) => p.isEventSubscriber,
				).length;
				totalProcedures += obj.procedures.length;
				totalTriggers += obj.triggers.length;
				totalEventSubscribers += eventSubCount;
				return {
					objectType: obj.objectType,
					objectName: obj.objectName,
					objectId: obj.objectId,
					file: obj.file.relativePath,
					procedureCount: obj.procedures.length,
					triggerCount: obj.triggers.length,
					eventSubscriberCount: eventSubCount,
				};
			});

			const findingCount = { critical: 0, warning: 0, info: 0 };
			for (const f of allFindings) {
				findingCount[f.severity]++;
			}

			const result: SourceAnalysisResult = {
				files: index.files.length,
				...(index.failedFiles.length > 0
					? { failedFiles: index.failedFiles }
					: {}),
				objects: objectSummaries,
				findings: allFindings,
				tableClusters,
				summary: {
					totalObjects: index.objects.size,
					totalProcedures,
					totalTriggers,
					totalEventSubscribers,
					findingCount,
				},
			};

			if (opts.format === "json") {
				process.stdout.write(JSON.stringify(result, null, 2) + "\n");
			} else {
				process.stdout.write(
					`Source Analysis: ${result.files} files, ${result.summary.totalObjects} objects\n`,
				);
				process.stdout.write(
					`  Procedures: ${totalProcedures} | Triggers: ${totalTriggers} | Event Subscribers: ${totalEventSubscribers}\n`,
				);
				process.stdout.write(
					`  Findings: ${findingCount.critical} critical, ${findingCount.warning} warning, ${findingCount.info} info\n`,
				);

				if (allFindings.length > 0) {
					process.stdout.write("\nFindings:\n");
					for (const f of allFindings) {
						process.stdout.write(`  [${f.severity}] ${f.title}\n`);
						if (f.suggestion)
							process.stdout.write(`    Fix: ${f.suggestion}\n`);
					}
				}

				if (tableClusters.length > 0) {
					process.stdout.write("\nTable Clusters:\n");
					for (const cluster of tableClusters) {
						process.stdout.write(
							`  ${cluster.recordVariable}: ${cluster.findingCount} finding(s)\n`,
						);
					}
				}
			}
		});
}
