import { describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { buildMongoGeoFilter, geoJsonToMongoDocuments, mongoConfigFromEnvironment, mongoDocumentsToGeoJson, parseMongoEjson, parseMongoJson, stringifyMongoJson, } from "./mongodb.js";
describe("mongoConfigFromEnvironment", () => {
    it("reads a MongoDB URI and database without rewriting its credentials", () => {
        expect(mongoConfigFromEnvironment({
            DBSTUDIO_MONGODB_URL: "mongodb://reader:p%40ss@localhost:27018/sample?authSource=admin",
        })).toEqual({
            uri: "mongodb://reader:p%40ss@localhost:27018/sample?authSource=admin",
            database: "sample",
            connectTimeoutMS: 10_000,
        });
    });
    it("supports a separate default database and rejects invalid configuration", () => {
        expect(mongoConfigFromEnvironment({
            MONGODB_URI: "mongodb+srv://reader:secret@cluster.example.net/",
            MONGODB_DATABASE: "demo",
            MONGODB_CONNECT_TIMEOUT_MS: "5000",
        })).toMatchObject({ database: "demo", connectTimeoutMS: 5000 });
        expect(() => mongoConfigFromEnvironment({})).toThrow("Configure MongoDB");
        expect(() => mongoConfigFromEnvironment({ MONGODB_URI: "postgres://localhost/demo" })).toThrow("mongodb://");
        expect(() => mongoConfigFromEnvironment({ MONGODB_URI: "mongodb://localhost", MONGODB_CONNECT_TIMEOUT_MS: "0" }))
            .toThrow("between 1 and 120000");
    });
});
describe("MongoDB JSON and BSON Extended JSON", () => {
    it("parses document arrays and round-trips ObjectId values as Extended JSON", () => {
        const id = new ObjectId("507f1f77bcf86cd799439011");
        const encoded = stringifyMongoJson([{ _id: id, label: "中文" }]);
        const parsed = parseMongoJson(encoded);
        expect(parsed[0]?._id).toEqual(id);
        expect(parsed[0]?.label).toBe("中文");
        expect(parseMongoEjson('{"$oid":"507f1f77bcf86cd799439011"}')).toBeInstanceOf(ObjectId);
        expect(() => parseMongoJson("[1, null]")).toThrow("document objects");
    });
});
describe("MongoDB GeoJSON support", () => {
    const point = { type: "Point", coordinates: [121.5, 31.2] };
    it("converts GeoJSON Features to documents and back with a configurable geometry field", () => {
        const documents = geoJsonToMongoDocuments({
            type: "FeatureCollection",
            features: [{ type: "Feature", id: "road-1", geometry: point, properties: { name: "道路一号", rank: 1 } }],
        }, "location.geometry");
        expect(documents).toEqual([{ name: "道路一号", rank: 1, location: { geometry: point }, _id: "road-1" }]);
        expect(mongoDocumentsToGeoJson(documents, "location.geometry")).toEqual({
            type: "FeatureCollection",
            features: [{ type: "Feature", id: "road-1", geometry: point, properties: { name: "道路一号", rank: 1 } }],
        });
    });
    it("places a standalone Geometry into a nested field path", () => {
        expect(geoJsonToMongoDocuments(point, "location.geometry")).toEqual([
            { location: { geometry: point } },
        ]);
    });
    it("builds native spatial filters and rejects invalid fields or geometry", () => {
        expect(buildMongoGeoFilter("location.geometry", { type: "Feature", geometry: point }, "intersects"))
            .toEqual({ "location.geometry": { $geoIntersects: { $geometry: point } } });
        expect(() => buildMongoGeoFilter("location.$where", point)).toThrow("field path");
        expect(() => buildMongoGeoFilter("geometry", { type: "Point", coordinates: "bad" })).toThrow("GeoJSON Geometry");
        expect(() => geoJsonToMongoDocuments({ type: "FeatureCollection", features: [null] })).toThrow("Geometry, Feature, or FeatureCollection");
    });
});
//# sourceMappingURL=mongodb.test.js.map