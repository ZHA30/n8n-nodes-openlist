import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
  Icon,
} from "n8n-workflow";

export class OpenListApi implements ICredentialType {
  name = "openListApi";
  icon: Icon = {
    light: "file:../nodes/OpenList/openlist.svg",
    dark: "file:../nodes/OpenList/openlist.svg",
  };
  displayName = "OpenList API";
  documentationUrl = "https://doc.oplist.org/";
  properties: INodeProperties[] = [
    {
      displayName: "Base URL",
      name: "baseUrl",
      type: "string",
      default: "",
      required: true,
      placeholder: "https://openlist.example.com",
      description: "Instance URL, including any deployment subpath",
    },
    {
      displayName: "API Token",
      name: "apiToken",
      type: "string",
      typeOptions: { password: true },
      default: "",
      required: true,
      description:
        "Admin API token or user login token, without a Bearer prefix",
    },
  ];
  authenticate: IAuthenticateGeneric = {
    type: "generic",
    properties: { headers: { Authorization: "={{$credentials.apiToken}}" } },
  };
  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{$credentials.baseUrl.replace(new RegExp("/+$"), "")}}',
      url: "/api/me",
    },
    rules: [
      {
        type: "responseSuccessBody",
        properties: {
          key: "data.id",
          value: undefined,
          message: "OpenList rejected the token",
        },
      },
    ],
  };
}
