import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn utility", () => {
  it("combines class names and merges classes", () => {
    expect(cn("btn", undefined, "btn-primary", "btn")).toBe("btn btn-primary btn");
  });

  it("handles falsy values cleanly", () => {
    expect(cn(false, "foo", null, "bar")).toBe("foo bar");
  });
});
