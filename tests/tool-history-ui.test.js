import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectDirectory = path.resolve(new URL("..", import.meta.url).pathname);

async function read(relativePath) {
  return fs.readFile(path.join(projectDirectory, relativePath), "utf8");
}

test("History supports selecting and deleting multiple visible results", async () => {
  const history = await read("components/tool-history.jsx");
  const styles = await read("styles/globals.css");
  assert.match(history, /const \[selectedIds, setSelectedIds\] = useState\(\(\) => new Set\(\)\)/);
  assert.match(history, /const selectedItems = items\.filter\(\(item\) => selectedIds\.has\(item\.id\)\)/);
  assert.match(history, /Select visible history results/);
  assert.match(history, /Delete selected \(\$\{selectedItems\.length\}\)/);
  assert.match(history, /Promise\.allSettled\(targets\.map\(\(item\) => deleteLocalHistory\(item\.id\)\)\)/);
  assert.match(history, /const deletedIds = new Set\(targets\.filter\(\(_, index\) => results\[index\]\.status === "fulfilled"\)/);
  assert.match(history, /checked=\{selectedIds\.has\(item\.id\)\}/);
  assert.match(history, /className="icon-button history-edit-button"/);
  assert.match(history, /onClick=\{\(\) => editItem\(item\)\}/);
  assert.match(history, /value="saved">Saved<\/option>/);
  assert.match(history, /value="completed">Completed<\/option>/);
  assert.match(history, /item\.historyStatus \|\| "completed"/);
  assert.doesNotMatch(history, /durationFilter/);
  assert.doesNotMatch(history, /Any duration/);
  assert.doesNotMatch(history, /formatDuration/);
  assert.doesNotMatch(history, /value="duration">Longest duration<\/option>/);
  assert.doesNotMatch(history, /sortBy === "duration"/);
  assert.match(styles, /\.history-selection-bar \{/);
  assert.match(styles, /\.history-item-select \{/);
  assert.match(styles, /\.history-bulk-delete \{/);
  assert.match(styles, /\.history-edit-button \{/);
});
