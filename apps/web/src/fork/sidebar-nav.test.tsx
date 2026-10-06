import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ForkSidebarNav, forkHiddenSidebarRoutes } from "./sidebar-nav";

// The filter looks at each child's `to` prop, whatever the component, so these
// stand-ins carry it without a router around them.
function Item({ to, label }: { to?: string; label: string }) {
  return <a href={to ?? "#"}>{label}</a>;
}

/** A component that has no `to`, like the cockpit link. */
function Custom() {
  return <a href="/cockpit">Cockpit</a>;
}

const html = (nav: React.ReactElement) => renderToStaticMarkup(nav);

describe("forkHiddenSidebarRoutes", () => {
  it("names the three entries the owner does not use", () => {
    expect([...forkHiddenSidebarRoutes]).toEqual([
      "/team-projects",
      "/projects",
      "/articles",
    ]);
  });
});

describe("ForkSidebarNav", () => {
  it("drops the links to the hidden routes", () => {
    const markup = html(
      <ForkSidebarNav>
        <Item label="All memos" to="/" />
        <Item label="Team projects" to="/team-projects" />
        <Item label="Projects" to="/projects" />
        <Item label="Articles" to="/articles" />
        <Item label="Memory" to="/memory" />
      </ForkSidebarNav>,
    );
    expect(markup).toContain("All memos");
    expect(markup).toContain("Memory");
    expect(markup).not.toContain("Team projects");
    expect(markup).not.toContain("Projects");
    expect(markup).not.toContain("Articles");
  });

  it("keeps every link whose route is not hidden, in order", () => {
    const markup = html(
      <ForkSidebarNav>
        <Item label="One" to="/" />
        <Item label="Two" to="/review/daily" />
        <Item label="Three" to="/review/walk" />
      </ForkSidebarNav>,
    );
    expect(markup.indexOf("One")).toBeGreaterThan(-1);
    expect(markup.indexOf("One")).toBeLessThan(markup.indexOf("Two"));
    expect(markup.indexOf("Two")).toBeLessThan(markup.indexOf("Three"));
  });

  it("matches the route exactly, so a longer path is not swept up", () => {
    const markup = html(
      <ForkSidebarNav>
        <Item label="Project detail" to="/projects/abc" />
        <Item label="Articles list" to="/articles/new" />
      </ForkSidebarNav>,
    );
    expect(markup).toContain("Project detail");
    expect(markup).toContain("Articles list");
  });

  it("passes conditional children through, shown or not", () => {
    const shown = html(
      <ForkSidebarNav>
        {true && <Item label="Capture" to="/capture" />}
        {false && <Item label="Never" to="/never" />}
        {null}
        {undefined}
      </ForkSidebarNav>,
    );
    expect(shown).toContain("Capture");
    expect(shown).not.toContain("Never");

    const hiddenOne = html(
      <ForkSidebarNav>
        {true && <Item label="Projects" to="/projects" />}
      </ForkSidebarNav>,
    );
    expect(hiddenOne).not.toContain("Projects");
  });

  it("passes other components through untouched", () => {
    const markup = html(
      <ForkSidebarNav>
        <Item label="Memory" to="/memory" />
        <Custom />
        <Item label="Projects" to="/projects" />
      </ForkSidebarNav>,
    );
    expect(markup).toContain("Cockpit");
    expect(markup).toContain("Memory");
    expect(markup).not.toContain("Projects");
  });

  it("passes plain elements and text through", () => {
    const markup = html(
      <ForkSidebarNav>
        <hr />
        some text
        <Item label="Memory" to="/memory" />
      </ForkSidebarNav>,
    );
    expect(markup).toContain("<hr/>");
    expect(markup).toContain("some text");
  });

  it("ignores a `to` that is not a route string", () => {
    const markup = html(
      <ForkSidebarNav>
        <Item label="Odd" to={undefined} />
        {/* @ts-expect-error: a non-string `to` must not crash the filter */}
        <Item label="Numeric" to={42} />
      </ForkSidebarNav>,
    );
    expect(markup).toContain("Odd");
    expect(markup).toContain("Numeric");
  });

  it("renders a nav element and forwards every prop", () => {
    const markup = html(
      <ForkSidebarNav
        aria-label="Navigation"
        className="mt-2 flex flex-col"
        data-testid="side-nav"
        id="explorer-nav"
      >
        <Item label="Memory" to="/memory" />
      </ForkSidebarNav>,
    );
    expect(markup.startsWith("<nav")).toBe(true);
    expect(markup).toContain('aria-label="Navigation"');
    expect(markup).toContain('class="mt-2 flex flex-col"');
    expect(markup).toContain('data-testid="side-nav"');
    expect(markup).toContain('id="explorer-nav"');
    expect(markup.endsWith("</nav>")).toBe(true);
  });

  it("renders an empty nav when every child is hidden", () => {
    const markup = html(
      <ForkSidebarNav aria-label="Navigation">
        <Item label="Projects" to="/projects" />
      </ForkSidebarNav>,
    );
    expect(markup).toBe('<nav aria-label="Navigation"></nav>');
  });
});
