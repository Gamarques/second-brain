import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EmptyActivityIllustration } from "./empty-activity";
import { EmptyDocumentsIllustration } from "./empty-documents";
import { EmptyFoldersIllustration } from "./empty-folders";
import { EmptyJobsIllustration } from "./empty-jobs";
import { EmptyLearningIllustration } from "./empty-learning";
import { EmptyMapIllustration } from "./empty-map";
import { EmptyMemoriesIllustration } from "./empty-memories";
import { EmptyPacksIllustration } from "./empty-packs";
import { EmptyProjectsIllustration } from "./empty-projects";
import { EmptyRemindersIllustration } from "./empty-reminders";
import { EmptyReviewsIllustration } from "./empty-reviews";
import { EmptyUsageIllustration } from "./empty-usage";
import { FolderMark } from "./folder-mark";

const drawings = [
  ["memories", EmptyMemoriesIllustration],
  ["folders", EmptyFoldersIllustration],
  ["reminders", EmptyRemindersIllustration],
  ["reviews", EmptyReviewsIllustration],
  ["map", EmptyMapIllustration],
  ["projects", EmptyProjectsIllustration],
  ["learning", EmptyLearningIllustration],
  ["jobs", EmptyJobsIllustration],
  ["activity", EmptyActivityIllustration],
  ["usage", EmptyUsageIllustration],
  ["documents", EmptyDocumentsIllustration],
  ["packs", EmptyPacksIllustration],
] as const;

describe("illustrations", () => {
  it.each(drawings)("%s: is decorative, drawn on the shared canvas, with exactly one sunrise element", (_name, Draw) => {
    const { container } = render(<Draw />);

    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("viewBox", "0 0 160 120");
    const sunriseUses = [...svg!.querySelectorAll("*")]
      .flatMap((element) => [...element.attributes].map((attribute) => attribute.value))
      .filter((value) => /^url\(#/.test(value));
    expect(sunriseUses).toHaveLength(1);
  });

  it("names the drawing when a title is given", () => {
    const { container } = render(<EmptyMemoriesIllustration title="An open notebook" />);

    expect(container.querySelector("svg")).toHaveAttribute("role", "img");
    expect(container.querySelector("svg title")).toHaveTextContent("An open notebook");
  });
});

describe("FolderMark", () => {
  it.each([
    [0, 0],
    [3, 1],
    [12, 2],
    [40, 3],
  ])("shows %i documents as %i sheets", (count, sheets) => {
    const { container } = render(<FolderMark count={count} />);

    expect(container.querySelector("svg")).toHaveAttribute("data-sheets", String(sheets));
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});
