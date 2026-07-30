/**
 * Minimal S3 client (AWS Signature V4) for the SeaweedFS gateway.
 *
 * Written by hand rather than pulling in @aws-sdk/client-s3: we need exactly
 * five operations (create bucket, put, get, delete, presign) against one
 * endpoint, and the SDK costs ~15 MB of dependencies and a slower image build
 * for that. SigV4 itself is ~80 lines; everything below is the spec, in order.
 *
 * Two endpoints are in play:
 *   - `endpoint`       reachable from this container (http://seaweed-s3:8333)
 *   - `publicEndpoint` reachable from the browser (presigned links point here)
 * They are signed independently, because the host header is part of the
 * signature.
 */
import { createHash, createHmac } from 'node:crypto';
import { config } from './config';
import { metrics } from './metrics';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
const UNSIGNED = 'UNSIGNED-PAYLOAD';

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) =>
	createHmac('sha256', key).update(data).digest();

/** RFC 3986. encodeURIComponent leaves !'()* alone; S3 wants them encoded. */
function uriEncode(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
	);
}

/** Object keys may contain slashes; those stay literal, everything else does not. */
const encodeKey = (key: string) => key.split('/').map(uriEncode).join('/');

function timestamps(now = new Date()) {
	const amzDate = now
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}/, '');
	return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function signingKey(dateStamp: string): Buffer {
	const kDate = hmac(`AWS4${config.s3.secretKey}`, dateStamp);
	const kRegion = hmac(kDate, config.s3.region);
	const kService = hmac(kRegion, SERVICE);
	return hmac(kService, 'aws4_request');
}

function canonicalQuery(query: Record<string, string>): string {
	return Object.keys(query)
		.sort()
		.map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
		.join('&');
}

/** `scope` is shared between the credential string and the string to sign. */
const scope = (dateStamp: string) => `${dateStamp}/${config.s3.region}/${SERVICE}/aws4_request`;

function stringToSign(amzDate: string, dateStamp: string, canonicalRequest: string): string {
	return [ALGORITHM, amzDate, scope(dateStamp), sha256(canonicalRequest)].join('\n');
}

interface Signed {
	url: string;
	headers: Record<string, string>;
}

/** Sign a request with the Authorization header (server-to-server calls). */
function signRequest(opts: {
	method: string;
	path: string;
	query?: Record<string, string>;
	headers?: Record<string, string>;
	body?: Buffer;
}): Signed {
	const base = new URL(config.s3.endpoint);
	const { amzDate, dateStamp } = timestamps();
	const payloadHash = sha256(opts.body ?? '');

	const headers: Record<string, string> = {
		...(opts.headers ?? {}),
		host: base.host,
		'x-amz-content-sha256': payloadHash,
		'x-amz-date': amzDate
	};

	const names = Object.keys(headers)
		.map((h) => h.toLowerCase())
		.sort();
	const canonicalHeaders = names.map((n) => `${n}:${String(headers[n] ?? '').trim()}\n`).join('');
	const signedHeaders = names.join(';');

	const canonicalRequest = [
		opts.method,
		opts.path,
		canonicalQuery(opts.query ?? {}),
		canonicalHeaders,
		signedHeaders,
		payloadHash
	].join('\n');

	const signature = hmac(
		signingKey(dateStamp),
		stringToSign(amzDate, dateStamp, canonicalRequest)
	).toString('hex');

	headers.authorization =
		`${ALGORITHM} Credential=${config.s3.accessKey}/${scope(dateStamp)}, ` +
		`SignedHeaders=${signedHeaders}, Signature=${signature}`;

	const qs = canonicalQuery(opts.query ?? {});
	return { url: `${base.origin}${opts.path}${qs ? `?${qs}` : ''}`, headers };
}

/**
 * A GET URL that anyone holding it can fetch until it expires.
 *
 * This is the ephemeral half of the link scheme: /api/uploads/<id> checks the
 * session and ownership, then redirects here. The URL is minted per request and
 * dies after `ttlSeconds`, so a leaked link is worthless within minutes and the
 * bytes never pass through Node.
 */
export function presignGet(
	key: string,
	ttlSeconds = config.s3.linkTtlSeconds,
	response?: { contentType?: string; filename?: string }
): string {
	const base = new URL(config.s3.publicEndpoint);
	const { amzDate, dateStamp } = timestamps();
	const path = `/${config.s3.bucket}/${encodeKey(key)}`;

	const query: Record<string, string> = {
		'X-Amz-Algorithm': ALGORITHM,
		'X-Amz-Credential': `${config.s3.accessKey}/${scope(dateStamp)}`,
		'X-Amz-Date': amzDate,
		'X-Amz-Expires': String(Math.max(1, Math.min(604800, Math.floor(ttlSeconds)))),
		'X-Amz-SignedHeaders': 'host'
	};
	if (response?.contentType) query['response-content-type'] = response.contentType;
	if (response?.filename) {
		// Inline: these are images the browser is expected to render, not download.
		query['response-content-disposition'] =
			`inline; filename="${response.filename.replace(/[^\w.\- ]+/g, '_')}"`;
	}

	const canonicalRequest = [
		'GET',
		path,
		canonicalQuery(query),
		`host:${base.host}\n`,
		'host',
		UNSIGNED
	].join('\n');

	const signature = hmac(
		signingKey(dateStamp),
		stringToSign(amzDate, dateStamp, canonicalRequest)
	).toString('hex');

	return `${base.origin}${path}?${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
}

/**
 * Every gateway call goes through here, so this is where they get counted.
 *
 * `notFound` is a THIRD outcome next to ok and error, not a flavour of either. A
 * 404 from this gateway is normal for a delete (idempotent) and a real fault for
 * a get (a row pointing at bytes that are gone — the orphan case the storage
 * dashboard watches for), and collapsing them into "error" would bury the one
 * that matters under the one that does not.
 *
 * Note that presigned downloads never appear in these numbers: the browser
 * fetches those from the gateway directly and the bytes never pass through Node.
 * That is the point of the presign scheme, and it means chatgsi_s3_bytes_total
 * counts server-side traffic only.
 */
async function send(operation: string, signed: Signed, init: RequestInit = {}): Promise<Response> {
	const started = process.hrtime.bigint();
	try {
		const res = await fetch(signed.url, { ...init, headers: signed.headers });
		if (!res.ok && res.status !== 404) {
			metrics.s3Operations.inc({ operation, outcome: 'error' });
			throw new Error(`s3 ${init.method ?? 'GET'} failed: ${res.status} ${await res.text()}`);
		}
		metrics.s3Operations.inc({
			operation,
			outcome: res.status === 404 ? 'not_found' : 'ok'
		});
		return res;
	} catch (err) {
		// Distinguishable from the branch above: that one already counted an HTTP
		// error, this one is the gateway being unreachable at all.
		if (err instanceof Error && err.message.startsWith('s3 ')) throw err;
		metrics.s3Operations.inc({ operation, outcome: 'unreachable' });
		throw err;
	} finally {
		metrics.s3Duration.observe({ operation }, Number(process.hrtime.bigint() - started) / 1e9);
	}
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
	const signed = signRequest({
		method: 'PUT',
		path: `/${config.s3.bucket}/${encodeKey(key)}`,
		headers: { 'content-type': contentType },
		body
	});
	const res = await send('put', signed, { method: 'PUT', body: new Uint8Array(body) });
	if (res.status === 404) throw new Error(`s3 PUT failed: bucket ${config.s3.bucket} not found`);
	metrics.s3Bytes.inc({ direction: 'up' }, body.byteLength);
}

export async function getObject(
	key: string
): Promise<{ body: Buffer; contentType: string } | null> {
	const signed = signRequest({
		method: 'GET',
		path: `/${config.s3.bucket}/${encodeKey(key)}`
	});
	const res = await send('get', signed, { method: 'GET' });
	if (res.status === 404) return null;
	const body = Buffer.from(await res.arrayBuffer());
	metrics.s3Bytes.inc({ direction: 'down' }, body.byteLength);
	return {
		body,
		contentType: res.headers.get('content-type') ?? 'application/octet-stream'
	};
}

/** S3 delete is idempotent: a missing key is a success, which is what we want. */
export async function deleteObject(key: string): Promise<void> {
	const signed = signRequest({
		method: 'DELETE',
		path: `/${config.s3.bucket}/${encodeKey(key)}`
	});
	await send('delete', signed, { method: 'DELETE' });
}

let bucketReady: Promise<void> | null = null;

/**
 * Create the bucket at most once per process, on the first write.
 *
 * Not done at module load: SvelteKit imports server modules during `vite build`,
 * where there is no gateway to talk to.
 */
export function ensureBucketOnce(): Promise<void> {
	return (bucketReady ??= ensureBucket().catch((err) => {
		bucketReady = null; // a transient gateway failure must not poison the process
		throw err;
	}));
}

/** Idempotent; safe to call on every boot. */
export async function ensureBucket(): Promise<void> {
	const signed = signRequest({ method: 'PUT', path: `/${config.s3.bucket}` });
	const started = process.hrtime.bigint();
	try {
		const res = await fetch(signed.url, {
			method: 'PUT',
			headers: signed.headers
		});
		// 409 = BucketAlreadyOwnedByYou, which is the steady state after first boot.
		if (!res.ok && res.status !== 409) {
			metrics.s3Operations.inc({ operation: 'create_bucket', outcome: 'error' });
			throw new Error(`s3 create bucket failed: ${res.status} ${await res.text()}`);
		}
		metrics.s3Operations.inc({
			operation: 'create_bucket',
			outcome: res.status === 409 ? 'exists' : 'ok'
		});
	} catch (err) {
		if (err instanceof Error && err.message.startsWith('s3 ')) throw err;
		metrics.s3Operations.inc({ operation: 'create_bucket', outcome: 'unreachable' });
		throw err;
	} finally {
		metrics.s3Duration.observe(
			{ operation: 'create_bucket' },
			Number(process.hrtime.bigint() - started) / 1e9
		);
	}
}
