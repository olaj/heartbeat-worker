import { describe, expect, it } from "vitest";
import { formatDuration, humanDuration, parseDuration } from "../src/duration";

describe("durations", () => {
  it("parses the four units", () => {
    expect(parseDuration("90s")).toBe(90);
    expect(parseDuration("10m")).toBe(600);
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("7d")).toBe(604800);
  });

  it("refuses anything else", () => {
    for (const bad of ["", "10", "1.5h", "-1m", "1w", "1h30m", " 1h"]) expect(parseDuration(bad)).toBeNull();
  });

  it("formats in the largest exact unit", () => {
    expect(formatDuration(86400)).toBe("1d");
    expect(formatDuration(5400)).toBe("90m");
    expect(formatDuration(90)).toBe("90s");
  });

  it("writes a rough human length", () => {
    expect(humanDuration(42 * 60000)).toBe("42m");
    expect(humanDuration(185 * 60000)).toBe("3h 5m");
    expect(humanDuration(52 * 3600000)).toBe("2d 4h");
  });
});
