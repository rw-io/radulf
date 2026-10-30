import { checkConnection, deleteConnection } from "@/server/forgeConnections";
import { json, handle } from "../../../_lib";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    const refresh = new URL(req.url).searchParams.get("refresh") === "1";
    return json(await checkConnection(id, { refresh }));
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const { id } = await params;
    deleteConnection(id);
    return json({ ok: true });
  });
}
