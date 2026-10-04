import { ConflictError } from "@flaremo/domain";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { HonoBindings } from "./context";
import { jsonError } from "./http";

/**
 * `jsonError` is the single error envelope for the `/api/app/*` surface: it
 * answers anything unrecognized with a generic 500 so internal detail cannot
 * leak. These cases pin the one addition — a framework error carrying its own
 * 4xx and a caller-facing message keeps both — and, just as importantly, the
 * shapes that must still degrade to a generic 500.
 */

/** Better Auth's APIError shape: numeric `statusCode` plus a message. */
function betterAuthError(statusCode: number, message: string) {
  const error = new Error(message);
  (error as Error & { statusCode: number }).statusCode = statusCode;
  return error;
}

function appFor(error: unknown) {
  const app = new Hono<HonoBindings>();
  app.get("/probe", (c) => jsonError(c, error));
  return app;
}

function probe(error: unknown) {
  return appFor(error).fetch(new Request("http://flaremo.test/probe"));
}

describe("jsonError", () => {
  it("keeps a domain error's status and message", async () => {
    const response = await probe(
      new ConflictError("That email is already in use."),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { message: "That email is already in use." },
    });
  });

  it("keeps a framework error's own 4xx and caller-facing message", async () => {
    const response = await probe(
      betterAuthError(422, "User already exists. Use another email."),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: { message: "User already exists. Use another email." },
    });
  });

  it("reads the status name field Better Auth also sets", async () => {
    const error = new Error("Invalid email") as Error & { status: number };
    error.status = 400;
    const response = await probe(error);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: "Invalid email" },
    });
  });

  it("does not promote a 5xx framework error into a caller-facing one", async () => {
    const response = await probe(betterAuthError(500, "Failed to create user"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { message: "Internal server error" },
    });
  });

  it("keeps a status-carrying error with no message generic", async () => {
    const error = new Error("") as Error & { statusCode: number };
    error.statusCode = 422;
    const response = await probe(error);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { message: "Internal server error" },
    });
  });

  it("keeps a bare driver error generic", async () => {
    // The shape a D1 unique-index violation actually throws: no status at all.
    const response = await probe(
      new Error('Failed query: insert into "users" ("email") values (?)'),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { message: "Internal server error" },
    });
  });
});
