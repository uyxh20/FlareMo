// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { plannerSetAsk, usePlannerAsk } from "@/planner/ask-store";
import { ForkComposerSummarizeButton } from "./summarize-link";
import { forkTestMount } from "./test-render";

// The composer's Summarize button (docs/fork-link-summaries.md): greyed out
// until the text holds a link, hidden without the agent, and a click opens a
// new Ask chat with the request typed in.

const enabled = { value: true };
vi.mock("@/planner/ask-api", () => ({
  plannerFetchAsk: async () => ({ enabled: enabled.value }),
}));

let seen: ReturnType<typeof usePlannerAsk> | null = null;
function Spy() {
  seen = usePlannerAsk();
  return null;
}

function mount(content: string) {
  const client = new QueryClient();
  return forkTestMount(
    <QueryClientProvider client={client}>
      <ForkComposerSummarizeButton content={content} />
      <Spy />
    </QueryClientProvider>,
  );
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

describe("the composer's Summarize button", () => {
  afterEach(() => {
    enabled.value = true;
    plannerSetAsk({ open: false, fresh: false, conversation: null, draft: "" });
  });

  it("is greyed out until the text holds a link", async () => {
    const view = mount("Just a thought");
    await settle();
    const button = view.container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe(
      "Paste a link to summarize it",
    );
    expect(button?.disabled).toBe(true);
    view.unmount();
  });

  it("opens a new Ask chat with the request typed in", async () => {
    const view = mount("Watch https://youtu.be/abc later");
    await settle();
    const button = view.container.querySelector("button");
    expect(button?.disabled).toBe(false);
    act(() => button?.click());
    expect(seen).toMatchObject({
      open: true,
      fresh: true,
      conversation: null,
      draft:
        "Summarize the key points of this link into a diary entry:\nhttps://youtu.be/abc",
    });
    view.unmount();
  });

  it("is not there without the agent", async () => {
    enabled.value = false;
    const view = mount("https://youtu.be/abc");
    await settle();
    expect(view.container.querySelector("button")).toBeNull();
    view.unmount();
  });
});
