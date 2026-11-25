import { z } from "zod";
export declare const connectionProfileSchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodString>;
    name: z.ZodString;
    engine: z.ZodEnum<{
        mariadb: "mariadb";
        mongodb: "mongodb";
        mysql: "mysql";
        oracle: "oracle";
        postgres: "postgres";
        sqlite: "sqlite";
        sqlserver: "sqlserver";
    }>;
    host: z.ZodOptional<z.ZodString>;
    port: z.ZodOptional<z.ZodNumber>;
    database: z.ZodOptional<z.ZodString>;
    user: z.ZodOptional<z.ZodString>;
    password: z.ZodOptional<z.ZodString>;
    uri: z.ZodOptional<z.ZodString>;
    path: z.ZodOptional<z.ZodString>;
    ssl: z.ZodOptional<z.ZodBoolean>;
    encrypt: z.ZodOptional<z.ZodBoolean>;
    trustServerCertificate: z.ZodOptional<z.ZodBoolean>;
    ssh: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodBoolean;
        host: z.ZodOptional<z.ZodString>;
        port: z.ZodOptional<z.ZodNumber>;
        username: z.ZodOptional<z.ZodString>;
        authentication: z.ZodOptional<z.ZodEnum<{
            password: "password";
            privateKey: "privateKey";
        }>>;
        hostFingerprint: z.ZodOptional<z.ZodString>;
        password: z.ZodOptional<z.ZodString>;
        privateKey: z.ZodOptional<z.ZodString>;
        passphrase: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strict>;
export declare const tableRowChangeSchema: z.ZodObject<{
    primaryKeyValues: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    values: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.core.$strict>;
export declare const columnMappingSchema: z.ZodObject<{
    sourceColumn: z.ZodString;
    targetColumn: z.ZodString;
}, z.core.$strict>;
export declare const ipcArgSchemas: {
    readonly "connections:save": z.ZodTuple<[z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodString;
        engine: z.ZodEnum<{
            mariadb: "mariadb";
            mongodb: "mongodb";
            mysql: "mysql";
            oracle: "oracle";
            postgres: "postgres";
            sqlite: "sqlite";
            sqlserver: "sqlserver";
        }>;
        host: z.ZodOptional<z.ZodString>;
        port: z.ZodOptional<z.ZodNumber>;
        database: z.ZodOptional<z.ZodString>;
        user: z.ZodOptional<z.ZodString>;
        password: z.ZodOptional<z.ZodString>;
        uri: z.ZodOptional<z.ZodString>;
        path: z.ZodOptional<z.ZodString>;
        ssl: z.ZodOptional<z.ZodBoolean>;
        encrypt: z.ZodOptional<z.ZodBoolean>;
        trustServerCertificate: z.ZodOptional<z.ZodBoolean>;
        ssh: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodBoolean;
            host: z.ZodOptional<z.ZodString>;
            port: z.ZodOptional<z.ZodNumber>;
            username: z.ZodOptional<z.ZodString>;
            authentication: z.ZodOptional<z.ZodEnum<{
                password: "password";
                privateKey: "privateKey";
            }>>;
            hostFingerprint: z.ZodOptional<z.ZodString>;
            password: z.ZodOptional<z.ZodString>;
            privateKey: z.ZodOptional<z.ZodString>;
            passphrase: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strict>], null>;
    readonly "connections:remove": z.ZodTuple<[z.ZodString], null>;
    readonly "connections:test": z.ZodTuple<[z.ZodString], null>;
    readonly "connections:list": z.ZodTuple<[], null>;
    readonly "database:query": z.ZodTuple<[z.ZodString, z.ZodString, z.ZodOptional<z.ZodArray<z.ZodUnknown>>], null>;
    readonly "database:tables": z.ZodTuple<[z.ZodString, z.ZodOptional<z.ZodString>, z.ZodOptional<z.ZodObject<{
        limit: z.ZodNumber;
    }, z.core.$strip>>], null>;
    readonly "database:columns": z.ZodTuple<[z.ZodString, z.ZodString, z.ZodOptional<z.ZodString>], null>;
    readonly "database:update-rows": z.ZodTuple<[z.ZodString, z.ZodObject<{
        schema: z.ZodString;
        table: z.ZodString;
        changes: z.ZodArray<z.ZodObject<{
            primaryKeyValues: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            values: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        }, z.core.$strict>>;
    }, z.core.$strict>], null>;
    readonly "database:transfer-table": z.ZodTuple<[z.ZodString, z.ZodObject<{
        targetConnectionId: z.ZodString;
        sourceTable: z.ZodString;
        sourceSchema: z.ZodOptional<z.ZodString>;
        targetTable: z.ZodString;
        targetSchema: z.ZodOptional<z.ZodString>;
        pageSize: z.ZodOptional<z.ZodNumber>;
        columnMappings: z.ZodOptional<z.ZodArray<z.ZodObject<{
            sourceColumn: z.ZodString;
            targetColumn: z.ZodString;
        }, z.core.$strict>>>;
    }, z.core.$strict>], null>;
    readonly "query-history:record": z.ZodTuple<[z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        connectionId: z.ZodOptional<z.ZodString>;
        connectionName: z.ZodOptional<z.ZodString>;
        engine: z.ZodOptional<z.ZodString>;
        sql: z.ZodString;
        executedAt: z.ZodOptional<z.ZodString>;
        command: z.ZodOptional<z.ZodString>;
        rowCount: z.ZodOptional<z.ZodNumber>;
        durationMs: z.ZodOptional<z.ZodNumber>;
        outcome: z.ZodOptional<z.ZodEnum<{
            error: "error";
            success: "success";
        }>>;
    }, z.core.$loose>], null>;
    readonly "query-history:clear": z.ZodTuple<[z.ZodOptional<z.ZodString>], null>;
    readonly "query-history:favorite:remove": z.ZodTuple<[z.ZodString], null>;
    readonly "ai:model:test": z.ZodTuple<[z.ZodEnum<{
        chat: "chat";
        embedding: "embedding";
        rerank: "rerank";
    }>, z.ZodRecord<z.ZodString, z.ZodUnknown>], null>;
    readonly "ai:schema-index:build": z.ZodTuple<[z.ZodString, z.ZodString, z.ZodArray<z.ZodString>, z.ZodString], null>;
    readonly "ai:schema-index:clear": z.ZodTuple<[z.ZodString, z.ZodString], null>;
    readonly "ai:assistant:run": z.ZodTuple<[z.ZodObject<{
        requestId: z.ZodString;
        connectionId: z.ZodString;
        modelId: z.ZodOptional<z.ZodString>;
        task: z.ZodEnum<{
            explain: "explain";
            "explain-plan": "explain-plan";
            generate: "generate";
            gis: "gis";
            optimize: "optimize";
            repair: "repair";
        }>;
        request: z.ZodString;
        schema: z.ZodOptional<z.ZodString>;
        schemas: z.ZodOptional<z.ZodArray<z.ZodString>>;
        selectedTables: z.ZodOptional<z.ZodArray<z.ZodString>>;
        includeSchema: z.ZodBoolean;
        refreshSchema: z.ZodOptional<z.ZodBoolean>;
        selectedSql: z.ZodOptional<z.ZodString>;
        executionPlan: z.ZodOptional<z.ZodString>;
        error: z.ZodOptional<z.ZodObject<{
            code: z.ZodOptional<z.ZodString>;
            message: z.ZodString;
            position: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strict>], null>;
    readonly "mongo:find": z.ZodTuple<[z.ZodString, z.ZodString, z.ZodString, z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>], null>;
    readonly "mongo:aggregate": z.ZodTuple<[z.ZodString, z.ZodString, z.ZodString, z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>, z.ZodNumber], null>;
    readonly "mongo:delete-document": z.ZodTuple<[z.ZodString, z.ZodString, z.ZodString, z.ZodString], null>;
    readonly "mongo:replace-document": z.ZodTuple<[z.ZodString, z.ZodString, z.ZodString, z.ZodString, z.ZodString], null>;
    readonly "gis:import": z.ZodTuple<[z.ZodString, z.ZodString, z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>, z.ZodOptional<z.ZodString>], null>;
    readonly "gis:export": z.ZodTuple<[z.ZodString, z.ZodString, z.ZodString, z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>, z.ZodOptional<z.ZodString>], null>;
};
export type IpcChannel = keyof typeof ipcArgSchemas;
export interface IpcValidationError {
    channel: string;
    issues: Array<{
        path: string;
        message: string;
    }>;
}
export declare function validateIpcArgs(channel: IpcChannel, args: unknown[]): IpcValidationError | undefined;
export declare function assertIpcArgs(channel: IpcChannel, args: unknown[]): void;
//# sourceMappingURL=ipc-contracts.d.ts.map