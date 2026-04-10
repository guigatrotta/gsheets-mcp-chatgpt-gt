import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type Env = {
  MCP_OBJECT: DurableObjectNamespace;
};

class MyMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "Google Sheets Reader",
    version: "1.0.0",
  });

  async init() {
    this.server.tool(
      "read_public_sheet",
      {
        spreadsheetId: z.string(),
        range: z.string().optional(),
      },
      async ({ spreadsheetId, range }) => {
        const targetRange = range?.trim() || "A:Z";
        const url =
          `https://sheets.googleapis.com/v4/spreadsheets/` +
          `${encodeURIComponent(spreadsheetId)}/values/` +
          `${encodeURIComponent(targetRange)}?key=${this.env.GOOGLE_API_KEY}`;

        const res = await fetch(url);

        if (!res.ok) {
          const text = await res.text();
          return {
            content: [
              {
                type: "text",
                text: `Erro ao ler planilha: ${res.status} ${text}`,
              },
            ],
          };
        }

        const data = await res.json<any>();
        const values = Array.isArray(data.values) ? data.values : [];

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  range: data.range,
                  rows: values.length,
                  values,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );
  }
}

export { MyMCP };

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      return MyMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
