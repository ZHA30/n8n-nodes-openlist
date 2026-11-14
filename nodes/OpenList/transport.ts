import {
  NodeApiError,
  type IDataObject,
  type IExecuteFunctions,
  type IHttpRequestOptions,
} from "n8n-workflow";

export async function api(
  context: IExecuteFunctions,
  baseUrl: string,
  endpoint: string,
  body?: IDataObject,
  extra: Partial<IHttpRequestOptions> = {},
): Promise<IDataObject> {
  const response = (await context.helpers.httpRequestWithAuthentication.call(
    context,
    "openListApi",
    {
      method: "POST",
      url: `${baseUrl}/api${endpoint}`,
      body,
      json: true,
      ...extra,
    },
  )) as { code: number; message: string; data: IDataObject | null };
  if (response.code !== 200)
    throw new NodeApiError(
      context.getNode(),
      { message: response.message, code: response.code },
      { message: response.message, httpCode: String(response.code) },
    );
  return response.data ?? {};
}

export async function download(
  context: IExecuteFunctions,
  url: string,
): Promise<Buffer> {
  return (await context.helpers.httpRequest({
    method: "GET",
    url,
    encoding: "arraybuffer",
  })) as Buffer;
}
