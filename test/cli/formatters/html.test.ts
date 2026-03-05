import { describe, test, expect } from "bun:test";
import { analyzeProfile } from "../../../src/core/analyzer.js";
import { formatAnalysisHtml } from "../../../src/cli/formatters/html.js";

const FIXTURES = "test/fixtures";

describe("formatAnalysisHtml", () => {
  test("includes HTML document structure", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisHtml(result);
    expect(output).toContain("<!DOCTYPE html>");
    expect(output).toContain("<html");
    expect(output).toContain("</html>");
  });

  test("includes BC theme styles", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisHtml(result);
    expect(output).toContain("#00B7C3");
    expect(output).toContain("Segoe UI");
    expect(output).toContain("13.5pt");
  });

  test("includes summary section", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisHtml(result);
    expect(output).toContain(result.summary.oneLiner);
  });

  test("includes hotspots table", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisHtml(result);
    expect(output).toContain("Top Hotspots");
    expect(output).toContain("ProcessLine");
  });

  test("includes detected patterns with severity", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisHtml(result);
    expect(output).toContain("Detected Patterns");
    expect(output).toMatch(/CRITICAL|WARNING|INFO/);
  });

  test("includes app breakdown", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisHtml(result);
    expect(output).toContain("App Breakdown");
    expect(output).toContain("My Extension");
  });

  test("includes suggestion when pattern has one", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisHtml(result);
    if (result.patterns.some((p) => p.suggestion)) {
      expect(output).toContain("Suggestion:");
    }
  });

  test("includes confidence and health scores", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisHtml(result);
    expect(output).toContain("Confidence");
    expect(output).toContain("Health");
  });

  test("includes object breakdown section", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisHtml(result);
    expect(output).toContain("Object Breakdown");
    expect(output).toContain("My Processor");
    expect(output).toContain("50000");
  });

  test("includes AI explanation when present", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    result.explanation = "This profile shows significant time in ProcessLine.";
    const output = formatAnalysisHtml(result);
    expect(output).toContain("section explanation");
    expect(output).toContain("This profile shows significant time in ProcessLine.");
  });

  test("omits explanation when not present", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisHtml(result);
    expect(output).not.toContain("section explanation");
  });

  test("escapes HTML in dynamic content", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    // Inject XSS into a hotspot function name
    if (result.hotspots.length > 0) {
      result.hotspots[0].functionName = '<script>alert("xss")</script>';
    }
    const output = formatAnalysisHtml(result);
    expect(output).not.toContain('<script>alert("xss")</script>');
    expect(output).toContain("&lt;script&gt;");
  });

  test("is self-contained with no external resource links", async () => {
    const result = await analyzeProfile(`${FIXTURES}/sampling-minimal.alcpuprofile`);
    const output = formatAnalysisHtml(result);
    expect(output).not.toMatch(/href="https?:\/\//);
    expect(output).not.toMatch(/src="https?:\/\//);
  });
});
