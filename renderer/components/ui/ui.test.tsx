import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { Button } from "./button";
import { Badge } from "./badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./card";

function renderIntoDocument(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

describe("UI primitives", () => {
  it("renders a button and supports asChild rendering", () => {
    const { container } = renderIntoDocument(
      <Button asChild>
        <a href="/test">Link</a>
      </Button>,
    );

    const anchor = container.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("href")).toBe("/test");
    expect(anchor?.textContent).toBe("Link");
  });

  it("renders a badge with the correct variant styling", () => {
    const { container } = renderIntoDocument(<Badge variant="danger">Danger</Badge>);

    const badge = container.firstElementChild;
    expect(badge?.textContent).toBe("Danger");
    expect(badge?.className).toContain("border-rose-200");
  });

  it("renders card components with header, title, description, and content", () => {
    const { container } = renderIntoDocument(
      <Card className="custom-card">
        <CardHeader>
          <CardTitle>Card Title</CardTitle>
          <CardDescription>Card description</CardDescription>
        </CardHeader>
        <CardContent>Card content</CardContent>
      </Card>,
    );

    expect(container.textContent).toContain("Card Title");
    expect(container.textContent).toContain("Card description");
    expect(container.textContent).toContain("Card content");
    expect(container.firstElementChild?.className).toContain("custom-card");
  });
});
