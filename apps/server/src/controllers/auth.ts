import { auth } from "../auth";
import { corsify } from "../http";

export const handleAuth = async (request: Request): Promise<Response> => {
  const response = await auth.handler(request);
  return corsify(request, response);
};
