import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { TabPanel, Tabs } from "./tabs";

const items = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Bravo" },
  { id: "c", label: "Charlie" },
];

/** A real controlled harness so repeated arrow-key presses move relative to the current selection, not a frozen prop. */
function Harness({ onChange }: { onChange: (id: string) => void }) {
  const [value, setValue] = useState("a");
  return (
    <>
      <Tabs
        items={items}
        label="Pick one"
        onChange={(id) => {
          setValue(id);
          onChange(id);
        }}
        value={value}
      />
      <TabPanel active={value === "a"} id="a">Alpha content</TabPanel>
      <TabPanel active={value === "b"} id="b">Bravo content</TabPanel>
    </>
  );
}

describe("Tabs", () => {
  it("draws an icon before the label when an item has one", () => {
    const Mark = ({ className }: { className?: string }) => <svg className={className} data-testid="mark" />;
    render(<Tabs items={[{ id: "a", label: "Alpha", icon: Mark }, { id: "b", label: "Bravo" }]} label="Pick one" onChange={() => {}} value="a" />);

    expect(screen.getByRole("tab", { name: "Alpha" })).toContainElement(screen.getByTestId("mark"));
    expect(screen.getByRole("tab", { name: "Bravo" }).querySelector("svg")).toBeNull();
  });

  it("draws the underline variant as a bar with the active tab underlined", () => {
    render(<Tabs items={items} label="Pick one" onChange={() => {}} value="b" variant="underline" />);

    expect(screen.getByRole("tablist")).toHaveClass("border-b");
    expect(screen.getByRole("tab", { name: "Bravo" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Bravo" })).toHaveAttribute("data-state", "active");
  });

  it("renders a tab for each item and marks the active one selected", () => {
    render(<Tabs items={items} label="Pick one" onChange={() => {}} value="b" />);

    expect(screen.getByRole("tab", { name: "Alpha" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "Bravo" })).toHaveAttribute("aria-selected", "true");
  });

  it("calls onChange when a tab is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole("tab", { name: "Charlie" }));

    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("moves selection with the arrow keys, wrapping at the ends", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    screen.getByRole("tab", { name: "Alpha" }).focus();
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("c");

    onChange.mockClear();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("a");
  });

  it("jumps to the first and last tab with Home and End", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    screen.getByRole("tab", { name: "Alpha" }).focus();
    await user.keyboard("{End}");
    expect(onChange).toHaveBeenLastCalledWith("c");

    onChange.mockClear();
    await user.keyboard("{Home}");
    expect(onChange).toHaveBeenLastCalledWith("a");
  });

  it("only renders the active panel's content", () => {
    render(<Harness onChange={() => {}} />);

    expect(screen.getByText("Alpha content")).toBeVisible();
    expect(screen.queryByText("Bravo content")).not.toBeInTheDocument();
  });
});
