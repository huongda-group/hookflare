import app from "./app";

export default {
	fetch: (...args: Parameters<typeof app.fetch>) => app.fetch(...args),
};
