# Database test containers

The Compose file defines separate `postgres`, `postgis`, `mysql`, `mariadb`, `mongodb`, `sqlserver` and `oracle` profiles. Each service binds only to `127.0.0.1` and uses a dedicated named volume. Compose does not reference other project containers or volumes.

1. Copy `.env.example` to `.env` in this folder and replace each local test password with a random value. Never commit `.env`.
2. Start only the required profile. Examples:

   ```powershell
   docker compose --env-file docker/.env -f docker/compose.yaml --profile postgres up -d postgres
   docker compose --env-file docker/.env -f docker/compose.yaml --profile postgis up -d postgis
   docker compose --env-file docker/.env -f docker/compose.yaml --profile mysql up -d mysql
   docker compose --env-file docker/.env -f docker/compose.yaml --profile mariadb up -d mariadb
   docker compose --env-file docker/.env -f docker/compose.yaml --profile mongodb up -d mongodb
   docker compose --env-file docker/.env -f docker/compose.yaml --profile sqlserver up -d sqlserver
   docker compose --env-file docker/.env -f docker/compose.yaml --profile oracle up -d oracle
   ```

3. Use the selected service's local port and test credentials only for this project. MySQL listens on `127.0.0.1:23306`; MariaDB listens on `127.0.0.1:23307`; MongoDB listens on `127.0.0.1:27018`; SQL Server listens on `127.0.0.1:21433`; Oracle Free listens on `127.0.0.1:21521` and exposes the `FREEPDB1` service.
4. Stop a service with the same Compose file and profile when finished. Keep its named volume unless you explicitly decide to remove this project's test data.

After building the CLI, run `pnpm run test:integration:sql` to test both MySQL and MariaDB. It creates unique test tables and views and removes only those objects afterward.

SQL Server runs Developer edition for local testing. Its Compose profile sets `ACCEPT_EULA=Y` only with explicit authorization; the authorized service uses the separate `sqlserver-test-data` volume. Set `SQLSERVER_SA_PASSWORD` in the ignored `.env` file.

The PostGIS service is already running as `db-studio-postgis-test` on `127.0.0.1:25432`. MySQL and MariaDB are started only after their test task is authorized. Database round-trip smoke checks use uniquely named tables and clean up only those tables and views.

Oracle uses Oracle's official `database/free:latest-lite` image and the Oracle Free Use Terms and Conditions. Accept those terms before downloading or running the image. It has its own `oracle-test-data` volume and a 6 GiB memory limit. The smoke test uses the `SYSTEM` account and removes only its uniquely named test tables and view.
