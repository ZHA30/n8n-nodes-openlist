const { test } = require("node:test");
const assert = require("node:assert/strict");
const { OpenList } = require("../dist/nodes/OpenList/OpenList.node");
const { OpenListApi } = require("../dist/credentials/OpenListApi.credentials");

function context(
  parameters,
  handle,
  { items = [{ json: {} }], continueOnFail = false } = {},
) {
  const requests = [];
  return {
    requests,
    getInputData: () => items,
    getCredentials: async () => ({
      baseUrl: "https://example.test/openlist/",
      apiToken: "secret",
    }),
    getNode: () => ({
      name: "OpenList",
      type: "openList",
      typeVersion: 1,
      parameters: {},
    }),
    getNodeParameter: (name, index, fallback) => {
      const value = (
        Array.isArray(parameters) ? parameters[index] : parameters
      )[name];
      if (name === "resource") return value ?? "file";
      if (value === undefined && fallback === undefined)
        throw new Error(`Missing parameter ${name}`);
      return value ?? fallback;
    },
    continueOnFail: () => continueOnFail,
    helpers: {
      httpRequestWithAuthentication: async function (credential, options) {
        assert.equal(credential, "openListApi");
        requests.push(options);
        return { code: 200, data: await handle(options, requests.length) };
      },
      httpRequest: async (options) => {
        requests.push(options);
        return Buffer.from("downloaded");
      },
      assertBinaryData: (index, field) => {
        assert.equal(field, "source");
        return {
          fileName: "报告 #?.txt",
          mimeType: "text/plain",
          data: "external-reference",
        };
      },
      getBinaryDataBuffer: async () => Buffer.from("uploaded"),
      prepareBinaryData: async (data, fileName) => ({
        data: data.toString("base64"),
        fileName,
        mimeType: "text/plain",
      }),
    },
  };
}

test("list paginates, respects limit, refreshes once, and preserves item linking", async () => {
  const ctx = context(
    {
      operation: "list",
      folderPath: "/docs",
      returnAll: false,
      limit: 3,
      options: { refresh: true },
    },
    (req, page) => {
      assert.equal(req.url, "https://example.test/openlist/api/fs/list");
      assert.equal(req.body.page, page);
      assert.equal(req.body.refresh, page === 1);
      return {
        content:
          page === 1
            ? [{ name: "a" }, { name: "b" }]
            : [{ name: "c" }, { name: "d" }],
        total: 4,
      };
    },
  );
  const [result] = await new OpenList().execute.call(ctx);
  assert.deepEqual(
    result.map((item) => item.json.path),
    ["/docs/a", "/docs/b", "/docs/c"],
  );
  assert.equal(ctx.requests[1].body.per_page, 1);
  assert.ok(result.every((item) => item.pairedItem.item === 0));
});

test("search converts storage paths to user paths, including the user root", async () => {
  const ctx = context(
    {
      operation: "search",
      folderPath: "/",
      query: "report",
      returnAll: true,
      options: { password: "directory-password" },
    },
    (req) => {
      if (req.url.endsWith("/me")) return { base_path: "/mount/private" };
      assert.equal(req.body.parent, "/");
      assert.equal(req.body.scope, 2);
      assert.equal(req.body.password, "directory-password");
      return {
        total: 2,
        content: [
          { parent: "/mount/private/docs", name: "report.pdf" },
          { parent: "/mount/private", name: "report.txt" },
        ],
      };
    },
  );
  const [result] = await new OpenList().execute.call(ctx);
  assert.deepEqual(
    result.map((item) => item.json.path),
    ["/docs/report.pdf", "/report.txt"],
  );
});

test("download encodes the full user path and signature without forwarding the API token", async () => {
  const ctx = context(
    {
      operation: "download",
      path: "/报告 #?.txt",
      outputBinaryField: "file",
      options: {},
    },
    (req) =>
      req.url.endsWith("/me")
        ? { base_path: "/private" }
        : { name: "报告 #?.txt", sign: "signed+token", is_dir: false },
  );
  const [[item]] = await new OpenList().execute.call(ctx);
  const download = ctx.requests.at(-1);
  const url = new URL(download.url);
  assert.equal(
    decodeURIComponent(url.pathname),
    "/openlist/p/private/报告 #?.txt",
  );
  assert.equal(url.searchParams.get("sign"), "signed+token");
  assert.equal(url.searchParams.get("force"), "true");
  assert.equal(download.headers, undefined);
  assert.equal(
    Buffer.from(item.binary.file.data, "base64").toString(),
    "downloaded",
  );
  assert.equal(item.binary.file.fileName, "报告 #?.txt");
});

test("upload reads external binary data through helpers and disables overwrite", async () => {
  const ctx = context(
    {
      operation: "upload",
      folderPath: "/docs",
      inputBinaryField: "source",
      fileName: "",
      options: {},
    },
    (req) => {
      assert.equal(req.method, "PUT");
      assert.equal(
        decodeURIComponent(req.headers["File-Path"]),
        "/docs/报告 #?.txt",
      );
      assert.equal(req.headers.Overwrite, "false");
      assert.equal(req.headers["Content-Length"], 8);
      assert.equal(req.body.toString(), "uploaded");
      return null;
    },
  );
  const [[item]] = await new OpenList().execute.call(ctx);
  assert.equal(item.json.path, "/docs/报告 #?.txt");
  assert.equal(item.json.status, "completed");
});

test("copy retains queued tasks and evaluates expressions for each input", async () => {
  const ctx = context(
    [
      {
        operation: "copy",
        path: "/source/a",
        destination: "/target",
        options: {},
      },
      {
        operation: "move",
        path: "/source/b",
        destination: "/target",
        options: {},
      },
    ],
    (req) => {
      assert.equal(req.body.src_dir, "/source");
      assert.equal(req.body.dst_dir, "/target");
      return req.url.endsWith("/copy")
        ? { tasks: [{ id: "task-1" }] }
        : { message: "Completed" };
    },
    { items: [{ json: {} }, { json: {} }] },
  );
  const [result] = await new OpenList().execute.call(ctx);
  assert.equal(result[0].json.status, "submitted");
  assert.deepEqual(result[0].json.tasks, [{ id: "task-1" }]);
  assert.equal(result[1].json.status, "completed");
  assert.equal(result[1].pairedItem.item, 1);
  assert.deepEqual(
    ctx.requests.map((req) => req.body.names),
    [["a"], ["b"]],
  );
});

test("HTTP 200 business failures throw and continue-on-fail preserves input association", async () => {
  const ctx = context(
    { operation: "get", path: "/a", options: {} },
    () => ({}),
  );
  ctx.helpers.httpRequestWithAuthentication = async () => ({
    code: 403,
    message: "Permission denied",
    data: null,
  });
  await assert.rejects(
    () => new OpenList().execute.call(ctx),
    /Permission denied/,
  );
  ctx.continueOnFail = () => true;
  const [[result]] = await new OpenList().execute.call(ctx);
  assert.match(result.json.error, /Permission denied/);
  assert.equal(result.pairedItem.item, 0);
});

test("create, rename, and delete use the correct OpenList payloads", async () => {
  for (const [params, endpoint, body] of [
    [
      { operation: "create", folderPath: "/docs", name: "new" },
      "mkdir",
      { path: "/docs/new" },
    ],
    [
      { operation: "rename", path: "/docs/a", name: "b" },
      "rename",
      { path: "/docs/a", name: "b", overwrite: false },
    ],
    [
      { operation: "delete", path: "/docs/a" },
      "remove",
      { dir: "/docs", names: ["a"] },
    ],
  ]) {
    const ctx = context({ ...params, options: {} }, (req) => {
      assert.ok(req.url.endsWith(`/fs/${endpoint}`));
      assert.deepEqual(req.body, body);
      return null;
    });
    await new OpenList().execute.call(ctx);
  }
});

test("empty listings terminate and invalid names never issue a write", async () => {
  const empty = context(
    { operation: "list", folderPath: "/", returnAll: true, options: {} },
    () => ({ total: 100, content: [] }),
  );
  assert.deepEqual(await new OpenList().execute.call(empty), [[]]);
  assert.equal(empty.requests.length, 1);
  const invalid = context(
    { operation: "create", folderPath: "/", name: "../escape", options: {} },
    () => {
      throw new Error("Unexpected request");
    },
  );
  await assert.rejects(
    () => new OpenList().execute.call(invalid),
    /directory separators/,
  );
});

test("credential authentication sends a raw token and tests a real user response", () => {
  const credential = new OpenListApi();
  assert.equal(
    credential.authenticate.properties.headers.Authorization,
    "={{$credentials.apiToken}}",
  );
  const expression = credential.test.request.baseURL.slice(3, -2);
  assert.equal(
    new Function("$credentials", `return ${expression}`)({
      baseUrl: "https://host/openlist/",
    }),
    "https://host/openlist",
  );
  assert.equal(credential.test.rules[0].properties.key, "data.id");
});

test("folder search filters folders at the API and returns user-relative paths", async () => {
  const ctx = context(
    {
      resource: "folder",
      operation: "search",
      folderPath: "/",
      query: "docs",
      returnAll: true,
      options: {},
    },
    (req) => {
      if (req.url.endsWith("/me")) return { base_path: "/private" };
      assert.equal(req.body.scope, 1);
      return {
        total: 1,
        content: [{ parent: "/private", name: "docs", is_dir: true }],
      };
    },
  );
  const [[item]] = await new OpenList().execute.call(ctx);
  assert.equal(item.json.path, "/docs");
});

test("get returns metadata for the selected resource and rejects a mismatched path", async () => {
  for (const resource of ["file", "folder"]) {
    for (const isDir of [false, true]) {
      const ctx = context(
        { resource, operation: "get", path: "/docs", options: {} },
        () => ({ name: "docs", is_dir: isDir }),
      );
      if (isDir === (resource === "folder")) {
        const [[item]] = await new OpenList().execute.call(ctx);
        assert.equal(item.json.is_dir, isDir);
        assert.equal(item.json.path, "/docs");
      } else {
        await assert.rejects(
          () => new OpenList().execute.call(ctx),
          new RegExp(`requires a ${resource}`),
        );
      }
    }
  }
});
