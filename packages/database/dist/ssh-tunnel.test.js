import { createHash, generateKeyPairSync } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ssh2 from "ssh2";
import { fingerprintFromSsh2HostHash, normalizeSshFingerprint, SshTunnelManager, validateSshTunnelConfig, } from "./ssh-tunnel.js";
const LOOPBACK = "127.0.0.1";
describe("SSH tunnel", () => {
    it("normalizes and validates SHA-256 host fingerprints", () => {
        const fingerprint = `SHA256:${"a".repeat(43)}`;
        expect(normalizeSshFingerprint(`${fingerprint}=`)).toBe(fingerprint);
        expect(() => normalizeSshFingerprint("md5:00:11")).toThrow(/SHA256/);
        expect(fingerprintFromSsh2HostHash(Buffer.alloc(32, 7))).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    });
    it("requires a host fingerprint and the selected authentication credential", () => {
        const base = { host: "jump.example", port: 22, username: "dbstudio", authentication: "password" };
        expect(() => validateSshTunnelConfig({ ...base, hostFingerprint: "", password: "secret" })).toThrow(/指纹/);
        expect(() => validateSshTunnelConfig({ ...base, hostFingerprint: `SHA256:${"a".repeat(43)}` })).toThrow(/密码/);
        expect(validateSshTunnelConfig({ ...base, hostFingerprint: `SHA256:${"a".repeat(43)}`, password: "secret" }).password).toBe("secret");
    });
    describe("local forwarding", () => {
        let sshServer;
        let echoServer;
        let manager;
        let sshPort;
        let echoPort;
        let hostFingerprint;
        let sshConnections = 0;
        beforeAll(async () => {
            const { privateKey } = generateKeyPairSync("rsa", {
                modulusLength: 2048,
                privateKeyEncoding: { type: "pkcs1", format: "pem" },
                publicKeyEncoding: { type: "pkcs1", format: "pem" },
            });
            const parsedHostKey = ssh2.utils.parseKey(privateKey);
            if (parsedHostKey instanceof Error)
                throw parsedHostKey;
            hostFingerprint = fingerprintFromSsh2HostHash(createHash("sha256").update(parsedHostKey.getPublicSSH()).digest("hex"));
            echoServer = createServer((socket) => socket.on("data", (chunk) => socket.write(chunk)));
            await listen(echoServer);
            echoPort = echoServer.address().port;
            sshServer = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
                sshConnections += 1;
                client.on("error", () => undefined);
                client.on("authentication", (context) => {
                    if (context.method === "password" && context.username === "test-user" && context.password === "test-password")
                        context.accept();
                    else
                        context.reject();
                });
                client.on("ready", () => client.on("tcpip", (accept, reject, details) => {
                    if (details.destIP !== LOOPBACK || Number(details.destPort) !== echoPort) {
                        reject();
                        return;
                    }
                    const channel = accept();
                    const remote = createServerSocket(LOOPBACK, echoPort);
                    remote.once("error", () => channel.destroy());
                    channel.pipe(remote).pipe(channel);
                }));
            });
            await listen(sshServer);
            sshPort = sshServer.address().port;
            manager = new SshTunnelManager();
        }, 10_000);
        afterAll(async () => {
            await manager?.closeAll();
            await close(sshServer);
            await close(echoServer);
        });
        it("verifies the SSH host key and forwards bytes only through a loopback listener", async () => {
            await expect(manager.endpointFor("bad-fingerprint", {
                host: LOOPBACK, port: sshPort, username: "test-user", authentication: "password",
                password: "test-password", hostFingerprint: `SHA256:${"a".repeat(43)}`,
            }, { host: LOOPBACK, port: echoPort })).rejects.toThrow(/指纹不匹配/);
            const config = {
                host: LOOPBACK, port: sshPort, username: "test-user", authentication: "password",
                password: "test-password", hostFingerprint,
            };
            const connectionCountBefore = sshConnections;
            const firstRequest = manager.endpointFor("good-fingerprint", config, { host: LOOPBACK, port: echoPort });
            const secondRequest = manager.endpointFor("good-fingerprint", config, { host: LOOPBACK, port: echoPort });
            expect(manager.pendingCount).toBe(1);
            const [endpoint, reusedEndpoint] = await Promise.all([firstRequest, secondRequest]);
            expect(reusedEndpoint).toEqual(endpoint);
            expect(sshConnections - connectionCountBefore).toBe(1);
            expect(endpoint.host).toBe(LOOPBACK);
            expect(manager.activeCount).toBe(1);
            expect(manager.pendingCount).toBe(0);
            const response = await roundTrip(endpoint.host, endpoint.port, "dbstudio-ssh-smoke");
            expect(response).toBe("dbstudio-ssh-smoke");
            await manager.close("good-fingerprint");
            expect(manager.activeCount).toBe(0);
        }, 20_000);
    });
});
function listen(server) {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, LOOPBACK, () => {
            server.removeListener("error", reject);
            resolve();
        });
    });
}
function close(server) {
    if (!server?.listening)
        return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
}
function createServerSocket(host, port) {
    return createConnection(port, host);
}
function roundTrip(host, port, payload) {
    return new Promise((resolve, reject) => {
        const socket = createConnection(port, host);
        const chunks = [];
        socket.once("error", reject);
        socket.on("data", (chunk) => chunks.push(chunk));
        socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        socket.once("connect", () => {
            socket.write(payload);
            socket.end();
        });
    });
}
//# sourceMappingURL=ssh-tunnel.test.js.map