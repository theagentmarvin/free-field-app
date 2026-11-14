import { describe, expect, it } from "vitest";

import type { TaskEntryView } from "@ff/tasks";

import { buildTaskPrintHtml, type PrintTaskView } from "../src/printDocument";

/**
 * The task print document (§ field reports: "print to PDF" = the
 * browser's print dialog saving the iframe document). Builder-only —
 * the iframe/`print()` glue is host-side DOM, not logic.
 */

function entry(over: Partial<TaskEntryView> & { clientGuid: string }): TaskEntryView {
  const base: TaskEntryView = {
    id: over.clientGuid,
    action: "comment",
    text: "",
    by: "Sam",
    byUid: "u1",
    at: 2,
    statusFrom: 20,
    statusTo: 20,
    photos: [],
    clientGuid: over.clientGuid,
    pending: false,
    failed: false,
  };
  return { ...base, ...over };
}

const base: PrintTaskView = {
  num: 12,
  title: "Set door frame",
  description: "Second fix on L1",
  type: "punch",
  status: 20,
  assigneeName: "Ada",
  deadline: null,
  storeyName: "L1",
  hasBim: true,
  pdfPage: 3,
  createdBy: "Bob",
  createdAt: 1730000000000,
  entries: [],
  printedBy: "Sam",
  printedAt: "PRINTED-AT",
};

describe("buildTaskPrintHtml", () => {
  it("header: T-number, title, status band", () => {
    const html = buildTaskPrintHtml(base);
    expect(html).toContain("T012 — Set door frame");
    expect(html).toContain("Set door frame");
    expect(html).toContain("Ongoing");
    expect(html).toContain("FreeField task report · generated PRINTED-AT · Sam");
  });

  it("queued creates (num 0) print as uncommitted", () => {
    const html = buildTaskPrintHtml({ ...base, num: 0, status: null });
    expect(html).toContain("queued — not committed yet");
    expect(html).not.toContain("T012");
  });

  it("meta table: description, type, assignee, location lines, creator", () => {
    const html = buildTaskPrintHtml(base);
    expect(html).toContain("Second fix on L1");
    expect(html).toContain("Punch");
    expect(html).toContain("Ada");
    expect(html).toContain("3D pin");
    expect(html).toContain("plan pin · page 3");
    expect(html).toContain("Bob");
    expect(html).toContain("Storey");
    expect(html).toContain("L1");
  });

  it("escapes injected HTML in user fields", () => {
    const html = buildTaskPrintHtml({ ...base, title: "<script>alert(1)</script>", description: "<img onerror=x>" });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<img onerror");
  });

  it("timeline: state badges, queued marks, transitions", () => {
    const html = buildTaskPrintHtml({
      ...base,
      entries: [
        entry({ clientGuid: "c1", action: "create", statusFrom: null, statusTo: 10, by: "Bob" }),
        entry({ clientGuid: "gA", pending: true, text: "queued note" }),
        entry({ clientGuid: "gB", pending: true, failed: true }),
        entry({ clientGuid: "c2", action: "complete", statusFrom: 20, statusTo: 40 }),
      ],
    });
    expect(html).toContain("queued note");
    expect(html).toContain("⋯ queued — not yet committed");
    expect(html).toContain("⚠ failed — retry pending");
    expect(html).toContain("Ongoing → Awaiting approval"); // complete transition
    expect(html).toContain("Created"); // create verb label
  });

  it("photos: resolved URLs become imgs, unresolved stay 📷 chips", () => {
    const photo = { storagePath: "p/one.jpg", sha256: "a".repeat(64), size: 1, mime: "image/jpeg" };
    const html = buildTaskPrintHtml({
      ...base,
      entries: [
        entry({ clientGuid: "p1", photos: [photo] }),
        entry({ clientGuid: "p2", photos: [{ ...photo, storagePath: "p/two.jpg" }] }),
      ],
      photoUrls: { "p/one.jpg": "https://firebasestorage.example/one.jpg" },
    });
    expect(html).toContain('<img class="ph" src="https://firebasestorage.example/one.jpg"');
    expect(html).toContain("📷"); // p/two.jpg unresolved → count chip
    expect(html).not.toContain("p/two.jpg");
  });

  it("location snapshot thumb rides the Location row when present (Day-3)", () => {
    const html = buildTaskPrintHtml({
      ...base,
      locationThumbUrl: "https://firebasestorage.example/location-thumb.jpg",
    });
    expect(html).toContain('<img class="ph" src="https://firebasestorage.example/location-thumb.jpg"');
  });

  it("no location thumb URL → no img in the Location row", () => {
    const html = buildTaskPrintHtml(base);
    expect(html).not.toContain('alt="location snapshot"');
  });

  it("print stylesheet is self-contained and page-tuned", () => {
    const html = buildTaskPrintHtml(base);
    expect(html).toContain("@page");
    expect(html).toContain("break-inside: avoid");
    expect(html).toContain("print-color-adjust: exact");
  });

  it("2026-11-09 layout: brand band, num chip, status pill, meta grid, carded timeline, fixed footer", () => {
    const photo = { storagePath: "p/one.jpg", sha256: "a".repeat(64), size: 1, mime: "image/jpeg" };
    const html = buildTaskPrintHtml({
      ...base,
      entries: [entry({ clientGuid: "c1", action: "approve", statusFrom: 40, statusTo: 65, by: "Ada", photos: [photo] })],
      photoUrls: { "p/one.jpg": "https://firebasestorage.example/one.jpg" },
    });
    expect(html).toContain("FREE FIELD");
    expect(html).toContain('class="numchip"');
    expect(html).toContain('class="pill"');
    expect(html).toContain('class="grid"');
    expect(html).toContain('class="entry"');
    expect(html).toContain("position: fixed"); // footer prints on every page
    expect(html).toContain('class="photos"');
  });

  it("empty timeline prints a neutral placeholder card", () => {
    const html = buildTaskPrintHtml(base);
    expect(html).toContain("No entries yet");
  });
});

describe("buildTaskPrintHtml — w68 print polish", () => {
  it("status pill uses the app accent palette with readable ink (no raw CSS keyword like 'yellow')", () => {
    const html = buildTaskPrintHtml({ ...base, status: 20 });
    expect(html).not.toMatch(/background: yellow/);
    expect(html).toMatch(/\.pill \{[^}]*background: #[0-9a-f]{6}/i);
  });
  it("photos are letterboxed (contain), never cropped", () => {
    const html = buildTaskPrintHtml(base);
    expect(html).toContain("object-fit: contain");
    expect(html).not.toContain("object-fit: cover");
  });
});
