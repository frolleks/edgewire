import { json, requireAuth } from "../http";
import { createGatewayToken } from "../runtime";

export const createToken = async (request: Request): Promise<Response> => {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const token = createGatewayToken(authResult.user.id);
  return json(request, { token });
};
