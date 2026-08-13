import { describe, expect, test } from "bun:test";
import { parseClientTextMetric } from "./text-funnel-metrics-route";

describe("parseClientTextMetric", () => {
  test("accepts only the public aggregate event shapes", () => {
    expect(parseClientTextMetric({ event: "screen_opened" })).toEqual({ event: "screen_opened" });
    expect(parseClientTextMetric({ event: "text_copied", roomKind: "custom" })).toEqual({
      event: "text_copied",
      roomKind: "custom",
    });
    expect(parseClientTextMetric({
      event: "client_error",
      roomKind: "generated",
      errorCategory: "network",
    })).toEqual({
      event: "client_error",
      roomKind: "generated",
      outcome: "error",
      errorCategory: "network",
    });
  });

  test("rejects content, codes, PINs, identifiers, and unknown dimensions", () => {
    expect(parseClientTextMetric({ event: "screen_opened", code: "SECRET" })).toBeNull();
    expect(parseClientTextMetric({ event: "text_copied", text: "private text" })).toBeNull();
    expect(parseClientTextMetric({ event: "client_error", errorCategory: "network", pin: "1234" })).toBeNull();
    expect(parseClientTextMetric({ event: "second_device" })).toBeNull();
    expect(parseClientTextMetric({ event: "client_error", errorCategory: "raw database error" })).toBeNull();
    expect(parseClientTextMetric(null)).toBeNull();
  });
});
