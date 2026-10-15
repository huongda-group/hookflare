/** The resolver failed (network, HTTP, or a DNS status other than NOERROR/NXDOMAIN). */
export class DnsError extends Error {
	override name = "DnsError";
}

export type ResolveDns = (host: string) => Promise<string[]>;

const DOH_URL = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 3000;
const RECORD_TYPES = { A: 1, AAAA: 28 } as const;
const NOERROR = 0;
const NXDOMAIN = 3;

type DohResponse = {
	Status: number;
	Answer?: Array<{ type: number; data: string }>;
};

/** A + AAAA via DNS-over-HTTPS (JSON API). CNAME chains are followed by the resolver. */
export function createDohResolver(fetchFn: typeof fetch): ResolveDns {
	async function query(
		host: string,
		type: keyof typeof RECORD_TYPES,
	): Promise<string[]> {
		let res: Response;
		try {
			res = await fetchFn(
				`${DOH_URL}?name=${encodeURIComponent(host)}&type=${type}`,
				{
					headers: { accept: "application/dns-json" },
					signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
				},
			);
		} catch (err) {
			throw new DnsError(
				`doh request failed: ${err instanceof Error ? err.name : "unknown"}`,
			);
		}
		if (!res.ok) {
			throw new DnsError(`doh http ${res.status}`);
		}
		let body: DohResponse;
		try {
			body = await res.json();
		} catch {
			throw new DnsError("doh invalid json");
		}
		if (body.Status === NXDOMAIN) {
			return [];
		}
		if (body.Status !== NOERROR) {
			throw new DnsError(`doh status ${body.Status}`);
		}
		return (body.Answer ?? [])
			.filter((a) => a.type === RECORD_TYPES[type])
			.map((a) => a.data);
	}

	return async (host) => {
		const [a, aaaa] = await Promise.all([
			query(host, "A"),
			query(host, "AAAA"),
		]);
		return [...a, ...aaaa];
	};
}
