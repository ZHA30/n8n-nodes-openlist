import { posix } from "node:path";
import {
  NodeApiError,
  NodeConnectionTypes,
  NodeOperationError,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
} from "n8n-workflow";
import { properties } from "./properties";
import { api, download } from "./transport";

export class OpenList implements INodeType {
  description: INodeTypeDescription = {
    displayName: "OpenList",
    name: "openList",
    icon: { light: "file:openlist.svg", dark: "file:openlist.svg" },
    group: ["input", "output"],
    version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    usableAsTool: true,
    description: "Work with OpenList files and folders",
    defaults: { name: "OpenList" },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: "openListApi", required: true }],
    properties,
  };
  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const output: INodeExecutionData[] = [];
    const credentials = await this.getCredentials("openListApi");
    const baseUrl = String(credentials.baseUrl).replace(/\/+$/, "");
    for (let i = 0; i < items.length; i++) {
      try {
        const resource = this.getNodeParameter("resource", i) as string;
        const operation = this.getNodeParameter("operation", i) as string;
        const param = (name: string) =>
          this.getNodeParameter(name, i) as string;
        const options = this.getNodeParameter("options", i, {}) as IDataObject;
        const request = (endpoint: string, body?: IDataObject) =>
          api(this, baseUrl, endpoint, body);
        const name = () => {
          const value = param("name");
          if (!value || value === "." || value === ".." || /[/\\]/.test(value))
            throw new NodeOperationError(
              this.getNode(),
              "Enter a name without directory separators",
              { itemIndex: i },
            );
          return value;
        };
        const emit = (json: IDataObject) =>
          output.push({ json, pairedItem: { item: i } });
        if (operation === "list" || operation === "search") {
          const folder = posix.resolve("/", param("folderPath"));
          const all = this.getNodeParameter("returnAll", i) as boolean;
          const limit = all
            ? Infinity
            : (this.getNodeParameter("limit", i) as number);
          const user =
            operation === "search"
              ? await api(this, baseUrl, "/me", undefined, { method: "GET" })
              : undefined;
          const userRoot = posix.resolve("/", String(user?.base_path ?? "/"));
          let count = 0;
          for (let page = 1; count < limit; page++) {
            const body: IDataObject = {
              password: options.password ?? "",
              page,
              per_page: Math.min(100, limit - count),
            };
            if (operation === "list")
              Object.assign(body, {
                path: folder,
                refresh: page === 1 && Boolean(options.refresh),
              });
            else
              Object.assign(body, {
                parent: folder,
                keywords: param("query"),
                scope: resource === "folder" ? 1 : 2,
              });
            const result = await request(`/fs/${operation}`, body);
            const content = (result.content ?? []) as IDataObject[];
            for (const record of content.slice(0, limit - count)) {
              const parent =
                operation === "list"
                  ? folder
                  : posix.resolve(
                      "/",
                      posix.relative(userRoot, String(record.parent)),
                    );
              emit({
                ...record,
                ...(operation === "search" ? { parent } : {}),
                path: posix.join(parent, String(record.name)),
              });
              count++;
            }
            if (!content.length || count >= Number(result.total)) break;
          }
        } else if (operation === "get" || operation === "download") {
          const path = posix.resolve("/", param("path"));
          const record = await request("/fs/get", {
            path,
            password: options.password ?? "",
          });
          if (Boolean(record.is_dir) !== (resource === "folder"))
            throw new NodeOperationError(
              this.getNode(),
              resource === "folder"
                ? "This operation requires a folder"
                : "This operation requires a file",
              { itemIndex: i },
            );
          if (operation === "get") emit({ ...record, path });
          else {
            const user = await api(this, baseUrl, "/me", undefined, {
              method: "GET",
            });
            const fullPath = posix.join(String(user.base_path || "/"), path);
            const url = new URL(
              `${baseUrl}/p${fullPath.split("/").map(encodeURIComponent).join("/")}`,
            );
            url.searchParams.set("sign", String(record.sign ?? ""));
            url.searchParams.set("force", "true");
            url.searchParams.set("d", "true");
            const buffer = await download(this, url.toString());
            const binary = await this.helpers.prepareBinaryData(
              buffer as Buffer,
              String(record.name),
            );
            output.push({
              json: { ...record, path },
              binary: { [param("outputBinaryField")]: binary },
              pairedItem: { item: i },
            });
          }
        } else if (operation === "upload") {
          const field = param("inputBinaryField");
          const metadata = this.helpers.assertBinaryData(i, field);
          const fileName = param("fileName") || metadata.fileName;
          if (
            !fileName ||
            fileName === "." ||
            fileName === ".." ||
            /[/\\]/.test(fileName)
          )
            throw new NodeOperationError(
              this.getNode(),
              "Provide a file name without directory separators",
              { itemIndex: i },
            );
          const path = posix.join(
            posix.resolve("/", param("folderPath")),
            fileName,
          );
          const buffer = await this.helpers.getBinaryDataBuffer(i, field);
          const fileHeaders = {
            "File-Path": path.split("/").map(encodeURIComponent).join("/"),
            "Content-Type": metadata.mimeType,
            Overwrite: String(options.overwrite ?? false),
          };
          let result: IDataObject;
          if (this.getNodeParameter("uploadMode", i, "single") === "multipart") {
            const requestedChunkSize = Number(this.getNodeParameter("chunkSize", i, 10) || 10) * 1024 * 1024;
            const session = await api(this, baseUrl, "/fs/multipart/init", undefined, {
              method: "POST",
              headers: { ...fileHeaders, "X-File-Size": String(buffer.length), "X-Chunk-Size": String(requestedChunkSize) },
            });
            const uploadId = String(session.upload_id ?? "");
            const chunkSize = Number(session.chunk_size);
            if (!uploadId || !Number.isSafeInteger(chunkSize) || chunkSize < 1)
              throw new NodeApiError(this.getNode(), { message: "OpenList returned an invalid multipart session" }, { itemIndex: i });
            for (let index = 0; index * chunkSize < buffer.length; index++) {
              const chunk = buffer.subarray(index * chunkSize, Math.min((index + 1) * chunkSize, buffer.length));
              await api(this, baseUrl, "/fs/multipart/chunk", undefined, {
                method: "PUT",
                body: chunk,
                headers: { "X-Upload-Id": uploadId, "X-Chunk-Index": String(index), "Content-Length": chunk.length },
              });
            }
            result = await api(this, baseUrl, "/fs/multipart/complete", undefined, {
              method: "POST",
              headers: { "X-Upload-Id": uploadId },
            });
          } else {
            result = await api(this, baseUrl, "/fs/put", undefined, {
              method: "PUT",
              body: buffer,
              headers: { ...fileHeaders, "Content-Length": buffer.length, "As-Task": "false" },
            });
          }
          emit({ ...result, path, status: "completed" });
        } else if (operation === "create") {
          const path = posix.join(
            posix.resolve("/", param("folderPath")),
            name(),
          );
          await request("/fs/mkdir", { path });
          emit({ path, status: "completed" });
        } else {
          const path = posix.resolve("/", param("path"));
          let body: IDataObject;
          if (operation === "rename")
            body = {
              path,
              name: name(),
              overwrite: options.overwrite ?? false,
            };
          else if (operation === "delete")
            body = { dir: posix.dirname(path), names: [posix.basename(path)] };
          else if (operation === "copy" || operation === "move")
            body = {
              src_dir: posix.dirname(path),
              dst_dir: posix.resolve("/", param("destination")),
              names: [posix.basename(path)],
              overwrite: options.overwrite ?? false,
            };
          else
            throw new NodeOperationError(
              this.getNode(),
              `Unsupported operation: ${operation}`,
              { itemIndex: i },
            );
          const result = await request(
            `/fs/${operation === "delete" ? "remove" : operation}`,
            body,
          );
          emit({
            ...result,
            path,
            status:
              Array.isArray(result.tasks) && result.tasks.length
                ? "submitted"
                : "completed",
          });
        }
      } catch (error) {
        if (!this.continueOnFail()) {
          if (
            error instanceof NodeApiError ||
            error instanceof NodeOperationError
          ) {
            error.context.itemIndex = i;
            // Preserve the existing n8n error type and service details.
            // eslint-disable-next-line @n8n/community-nodes/require-node-api-error
            throw error;
          }
          throw new NodeApiError(
            this.getNode(),
            { message: (error as Error).message },
            { itemIndex: i },
          );
        }
        output.push({
          json: { error: (error as Error).message },
          pairedItem: { item: i },
        });
      }
    }
    return [output];
  }
}
