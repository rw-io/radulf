import { listConnections, saveConnection, type ForgeKind } from "@/server/forgeConnections";
import { ClientError } from "@/server/clientError";
import { record } from "@/server/requestValidation";
import { json, handle } from "../../_lib";

export async function GET() {
  return handle(() => json(listConnections()));
}

export async function POST(req: Request) {
  return handle(async () => {
    const body = record(await req.json(), "connection body");
    if (body.kind !== "gitea" && body.kind !== "forgejo") {
      throw new ClientError("kind must be gitea or forgejo");
    }
    if (typeof body.baseUrl !== "string" || typeof body.token !== "string" || !body.token.trim()) {
      throw new ClientError("baseUrl and token are required");
    }
    const connection = await saveConnection({
      kind: body.kind as ForgeKind,
      baseUrl: body.baseUrl,
      token: body.token,
    });
    return json(connection, 201);
  });
}
