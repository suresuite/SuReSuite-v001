import { describe, expect, it } from "vitest";
import { edgeErrorMessage } from "../edgeError";

const GENERIC = "Edge Function returned a non-2xx status code";
const failure = (status: number, body: string) =>
  Object.assign(new Error(GENERIC), { context: new Response(body, { status }) });

describe("edgeErrorMessage", () => {
  it("shows the server's own reason and the status, not the generic sentence", async () => {
    const m = await edgeErrorMessage(failure(400, JSON.stringify({ success: false, error: "That file is 40 MB; the limit is 32 MB." })), "x");
    expect(m).toBe("That file is 40 MB; the limit is 32 MB. (HTTP 400)");
    expect(m).not.toContain("non-2xx");
  });

  it("joins the error findings when the body carries them instead of an error", async () => {
    const m = await edgeErrorMessage(failure(422, JSON.stringify({ findings: [
      { level: "error", message: "row 3: level is not a number" }, { level: "warn", message: "ignored" },
      { level: "error", message: "row 9: parent unknown" },
    ] })), "x");
    expect(m).toBe("row 3: level is not a number\nrow 9: parent unknown (HTTP 422)");
  });

  it("shows plain text from a server that fell over, cut to 300 characters", async () => {
    const m = await edgeErrorMessage(failure(500, "canceling statement due to statement timeout".padEnd(500, "!")), "x");
    expect(m.startsWith("canceling statement due to statement timeout")).toBe(true);
    expect(m).toContain("(HTTP 500)");
    expect(m.length).toBeLessThan(330);
  });

  it("names the status when the body is empty", async () => {
    expect(await edgeErrorMessage(failure(546, ""), "The upload failed.")).toBe("The upload failed. (HTTP 546)");
  });

  it("falls back to the error's own message when there is no response to read", async () => {
    expect(await edgeErrorMessage(new Error("network down"), "x")).toBe("network down");
    expect(await edgeErrorMessage(null, "The upload failed.")).toBe("The upload failed.");
  });

  it("leaves the response readable for anyone else (it reads a clone)", async () => {
    const e = failure(400, JSON.stringify({ error: "nope" }));
    await edgeErrorMessage(e, "x");
    expect(await (e.context as Response).text()).toContain("nope");
  });
});
