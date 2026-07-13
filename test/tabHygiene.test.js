import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isBlankOrNewTabUrl, pruneExtraPages, prepareWorkingPage } from "../src/layers/tabHygiene.js";

describe("tabHygiene", () => {
  it("detects blank and new-tab urls", () => {
    assert.equal(isBlankOrNewTabUrl(""), true);
    assert.equal(isBlankOrNewTabUrl("about:blank"), true);
    assert.equal(isBlankOrNewTabUrl("chrome://newtab/"), true);
    assert.equal(isBlankOrNewTabUrl("https://jobs.ashbyhq.com/ditto"), false);
  });

  it("prepareWorkingPage keeps one page and closes the rest", async () => {
    const closed = [];
    const keep = {
      isClosed: () => false,
      url: () => "about:blank",
      bringToFront: async () => {},
      close: async () => {
        throw new Error("should not close keep page");
      },
    };
    const extras = [1, 2, 3].map((i) => ({
      isClosed: () => closed.includes(i),
      url: () => (i === 2 ? "about:blank" : `https://old.example/job/${i}`),
      close: async () => {
        closed.push(i);
      },
      bringToFront: async () => {},
    }));
    let list = [extras[0], keep, extras[1], extras[2]];
    const context = {
      pages: () => list.filter((p) => !p.isClosed()),
      newPage: async () => keep,
    };
    // Mutate list when close is called
    for (const p of extras) {
      const orig = p.close;
      p.close = async () => {
        await orig();
        list = list.filter((x) => x !== p);
      };
    }

    const page = await prepareWorkingPage(context);
    assert.equal(page, keep);
    assert.equal(context.pages().length, 1);
    assert.equal(context.pages()[0], keep);
  });

  it("pruneExtraPages closes ads and blanks around keep page", async () => {
    const closed = [];
    const keep = {
      isClosed: () => false,
      url: () => "https://jobs.ashbyhq.com/ditto/apply",
    };
    const blank = {
      isClosed: () => closed.includes("blank"),
      url: () => "about:blank",
      close: async () => {
        closed.push("blank");
      },
    };
    const ad = {
      isClosed: () => closed.includes("ad"),
      url: () => "https://doubleclick.net/ads",
      close: async () => {
        closed.push("ad");
      },
    };
    let list = [blank, keep, ad];
    blank.close = async () => {
      closed.push("blank");
      list = list.filter((p) => p !== blank);
    };
    ad.close = async () => {
      closed.push("ad");
      list = list.filter((p) => p !== ad);
    };
    const context = { pages: () => list.filter((p) => !p.isClosed()) };

    const result = await pruneExtraPages(context, keep, { maxPages: 1 });
    assert.ok(result.closed >= 2);
    assert.equal(context.pages().length, 1);
    assert.equal(context.pages()[0], keep);
  });
});
