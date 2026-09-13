const readline = require("node:readline");

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  let result = null;
  if (request.method === "initialize") {
    result = { protocolVersion: "2025-06-18", capabilities: {} };
  } else if (request.method === "tools/list") {
    result = {
      tools: [
        {
          name: "echo",
          description: "Echo",
          inputSchema: { type: "object" },
        },
      ],
    };
  } else if (request.method === "tools/call") {
    if (request.params.arguments.name === "fail") {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { isError: true },
      })}\n`);
      return;
    }
    result = {
      content: [
        {
          type: "text",
          text: `${request.params.arguments.name}:${process.env.PI_TEST_VALUE}`,
        },
      ],
    };
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
