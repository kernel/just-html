import { describe, expect, it } from "vitest";
import { annotateSource, decodeMap, parseSource } from "@/lib/docs/html-source";

/** The source text an element covers, per the map. */
function extent(html: string, id: number): string {
  const el = parseSource(html).elements[id];
  return html.slice(el.start, el.end);
}

function inner(html: string, id: number): string {
  const el = parseSource(html).elements[id];
  return html.slice(el.innerStart, el.innerEnd);
}

describe("parseSource extents", () => {
  it("covers a well-formed element and its content", () => {
    const html = "<p id=\"a\">Hello <strong>bold</strong></p>";
    expect(extent(html, 0)).toBe(html);
    expect(inner(html, 0)).toBe("Hello <strong>bold</strong>");
    expect(extent(html, 1)).toBe("<strong>bold</strong>");
    expect(inner(html, 1)).toBe("bold");
  });

  it("stops an implicitly closed element before the tag that closed it", () => {
    // htmlparser2's own endIndex reports the closing TRIGGER here, which would
    // make the two paragraphs' ranges overlap.
    const html = "<p>a<p>b";
    expect(extent(html, 0)).toBe("<p>a");
    expect(extent(html, 1)).toBe("<p>b");
  });

  it("handles implicitly closed list items", () => {
    const html = "<ul><li>a<li>b</ul>";
    expect(extent(html, 1)).toBe("<li>a");
    expect(extent(html, 2)).toBe("<li>b");
    expect(inner(html, 0)).toBe("<li>a<li>b");
  });

  it("does not mistake a '>' inside an attribute for the end of the start tag", () => {
    const html = '<p title="a>b">hi</p>';
    expect(inner(html, 0)).toBe("hi");
  });

  it("gives void elements an empty content range", () => {
    const html = "<div><br><img src=\"x>y\"></div>";
    const map = parseSource(html);
    expect(map.elements[1].tag).toBe("br");
    expect(extent(html, 1)).toBe("<br>");
    expect(inner(html, 1)).toBe("");
    expect(extent(html, 2)).toBe('<img src="x>y">');
  });

  it("tolerates whitespace in an end tag", () => {
    const html = "<pre>x\n</pre  >";
    expect(extent(html, 0)).toBe(html);
    expect(inner(html, 0)).toBe("x\n");
  });

  it("marks an unclosed element and ends it at its content", () => {
    const html = "<p>unclosed";
    const el = parseSource(html).elements[0];
    expect(el.hasEndTag).toBe(false);
    expect(extent(html, 0)).toBe("<p>unclosed");
  });

  it("numbers elements in document order and records parents", () => {
    const html = "<div><h1>T</h1><p>a</p></div>";
    const map = parseSource(html);
    expect(map.elements.map((e) => e.tag)).toEqual(["div", "h1", "p"]);
    expect(map.elements.map((e) => e.parent)).toEqual([null, 0, 0]);
  });

  it("records text children with their source ranges", () => {
    const html = "<p>R&amp;D and more</p>";
    const el = parseSource(html).elements[0];
    expect(el.children).toHaveLength(1);
    expect(html.slice(el.children[0].start, el.children[0].end)).toBe("R&amp;D and more");
  });
});

describe("annotateSource", () => {
  it("adds an id to every start tag and changes nothing else", () => {
    const html = '<!doctype html>\n<html><body>\n<p class="x">hi <em>there</em></p>\n</body></html>';
    const out = annotateSource(html);
    expect(out).toBe(
      '<!doctype html>\n<html data-jh-src="0"><body data-jh-src="1">\n' +
        '<p data-jh-src="2" class="x">hi <em data-jh-src="3">there</em></p>\n</body></html>'
    );
  });

  it("keeps the ids it writes in agreement with a fresh parse of the same source", () => {
    const html = "<div><p>one</p><ul><li>two</li></ul></div>";
    const out = annotateSource(html);
    const ids = [...out.matchAll(/data-jh-src="(\d+)"/g)].map((m) => Number(m[1]));
    expect(ids).toEqual(parseSource(html).elements.map((e) => e.id));
  });

  it("annotates a self-closing tag", () => {
    expect(annotateSource("<div><br/></div>")).toBe('<div data-jh-src="0"><br data-jh-src="1"/></div>');
  });
});

describe("decodeMap", () => {
  it("decodes named and numeric references", () => {
    expect(decodeMap("R&amp;D").text).toBe("R&D");
    expect(decodeMap("a&#66;c").text).toBe("aBc");
    expect(decodeMap("a&#x42;c").text).toBe("aBc");
    expect(decodeMap("no&nbsp;break").text).toBe("no break");
  });

  it("leaves an unknown reference alone", () => {
    expect(decodeMap("a&notarealentity;b").text).toBe("a&notarealentity;b");
  });

  it("maps each decoded character back to where it came from", () => {
    const dm = decodeMap("R&amp;D");
    expect(dm.text).toBe("R&D");
    expect(dm.at).toEqual([0, 1, 6, 7]);
    // Slicing at a mapped offset recovers the source for that decoded prefix.
    expect("R&amp;D".slice(0, dm.at[2])).toBe("R&amp;");
  });

  it("terminates the map at the slice length", () => {
    const dm = decodeMap("plain");
    expect(dm.at[dm.text.length]).toBe(5);
  });
});
