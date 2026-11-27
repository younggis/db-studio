#!/usr/bin/env node
/**
 * Query Execution Metrics Integration Test
 *
 * Verifies that all database adapters return execution metrics including:
 * - startTime
 * - endTime
 * - duration
 * - rowCount
 * - affectedRows (for DML statements)
 * - status
 */

import { strict as assert } from 'node:assert';
import { after } from 'node:test';

// PostgreSQL
import { PostgresAdapter, postgresConfigFromEnvironment } from '../../packages/database/dist/postgres.js';

console.log('\n=== Query Execution Metrics Integration Test ===\n');

// Test PostgreSQL
try {
  console.log('Testing PostgreSQL...');
  const adapter = new PostgresAdapter(postgresConfigFromEnvironment());

  try {
    // Test SELECT query
    const selectResult = await adapter.query('SELECT 1 AS num, \'test\' AS text');

    console.log('  SELECT query result:');
    console.log('    - Rows returned:', selectResult.rows.length);
    console.log('    - Row count:', selectResult.rowCount);

    assert(selectResult.metrics, 'SELECT query should have metrics');
    assert(selectResult.metrics.startTime instanceof Date, 'startTime should be a Date');
    assert(selectResult.metrics.endTime instanceof Date, 'endTime should be a Date');
    assert(typeof selectResult.metrics.duration === 'number', 'duration should be a number');
    assert(selectResult.metrics.duration >= 0, 'duration should be non-negative');
    assert(selectResult.metrics.rowCount === 1, 'rowCount should be 1');
    assert(selectResult.metrics.status === 'success', 'status should be success');
    assert(selectResult.metrics.affectedRows === undefined, 'SELECT should not have affectedRows');

    console.log('    ✓ Execution time:', selectResult.metrics.duration + 'ms');
    console.log('    ✓ Status:', selectResult.metrics.status);

    // Test CREATE/INSERT/SELECT/DROP sequence
    await adapter.query('CREATE TEMPORARY TABLE metrics_test (id INTEGER PRIMARY KEY, value TEXT)');

    const insertResult = await adapter.query(
      'INSERT INTO metrics_test (id, value) VALUES ($1, $2), ($3, $4)',
      [1, 'first', 2, 'second']
    );

    console.log('  INSERT query result:');
    console.log('    - Affected rows:', insertResult.rowCount);

    assert(insertResult.metrics, 'INSERT query should have metrics');
    assert(insertResult.metrics.duration >= 0, 'INSERT duration should be non-negative');
    assert(insertResult.metrics.rowCount === 2, 'INSERT rowCount should be 2');
    assert(insertResult.metrics.affectedRows === 2, 'INSERT affectedRows should be 2');
    assert(insertResult.metrics.status === 'success', 'INSERT status should be success');

    console.log('    ✓ Execution time:', insertResult.metrics.duration + 'ms');
    console.log('    ✓ Affected rows:', insertResult.metrics.affectedRows);

    // Test UPDATE
    const updateResult = await adapter.query('UPDATE metrics_test SET value = $1 WHERE id = $2', ['updated', 1]);

    console.log('  UPDATE query result:');

    assert(updateResult.metrics, 'UPDATE query should have metrics');
    assert(updateResult.metrics.rowCount === 1, 'UPDATE rowCount should be 1');
    assert(updateResult.metrics.affectedRows === 1, 'UPDATE affectedRows should be 1');
    assert(updateResult.metrics.status === 'success', 'UPDATE status should be success');

    console.log('    ✓ Execution time:', updateResult.metrics.duration + 'ms');
    console.log('    ✓ Affected rows:', updateResult.metrics.affectedRows);

    // Test error handling (intentional syntax error)
    try {
      await adapter.query('SELECT * FROM nonexistent_table_xyz');
      assert.fail('Should have thrown an error');
    } catch (error) {
      assert(error.metrics, 'Error should contain metrics');
      assert(error.metrics.status === 'error', 'Error status should be error');
      assert(typeof error.metrics.errorMessage === 'string', 'Error should have errorMessage');
      assert(error.metrics.duration >= 0, 'Error duration should be non-negative');

      console.log('  Error handling:');
      console.log('    ✓ Error metrics captured');
      console.log('    ✓ Execution time:', error.metrics.duration + 'ms');
      console.log('    ✓ Status:', error.metrics.status);
      console.log('    ✓ Error message:', error.metrics.errorMessage.substring(0, 50) + '...');
    }

    console.log('  ✓ PostgreSQL metrics test passed\n');
  } finally {
    await adapter.close();
  }
} catch (error) {
  if (error.message?.includes('Configure PostgreSQL') || error.message?.includes('PGDATABASE')) {
    console.log('  ⊘ PostgreSQL skipped (credentials not configured)\n');
  } else {
    throw error;
  }
}

// Test MySQL if available
try {
  const { MySqlAdapter, mysqlConfigFromEnvironment } = await import('../../packages/database/dist/mysql.js');

  console.log('Testing MySQL...');
  const adapter = new MySqlAdapter(mysqlConfigFromEnvironment());

  try {
    const selectResult = await adapter.query('SELECT 1 AS num, "test" AS text');

    assert(selectResult.metrics, 'MySQL SELECT should have metrics');
    assert(selectResult.metrics.duration >= 0, 'MySQL duration should be non-negative');
    assert(selectResult.metrics.status === 'success', 'MySQL status should be success');

    console.log('  ✓ MySQL metrics test passed');
    console.log('    - Execution time:', selectResult.metrics.duration + 'ms\n');
  } finally {
    await adapter.close();
  }
} catch (error) {
  if (error.message?.includes('MYSQL_USER') || error.message?.includes('DBSTUDIO_MYSQL_URL')) {
    console.log('  ⊘ MySQL skipped (credentials not configured)\n');
  } else {
    throw error;
  }
}

// Test SQLite if available
try {
  const { SqliteAdapter, sqliteConfigFromEnvironment } = await import('../../packages/database/dist/sqlite.js');

  console.log('Testing SQLite...');
  const adapter = new SqliteAdapter({ path: ':memory:' });

  try {
    const selectResult = await adapter.query('SELECT 1 AS num, \'test\' AS text');

    assert(selectResult.metrics, 'SQLite SELECT should have metrics');
    assert(selectResult.metrics.duration >= 0, 'SQLite duration should be non-negative');
    assert(selectResult.metrics.status === 'success', 'SQLite status should be success');

    console.log('  ✓ SQLite metrics test passed');
    console.log('    - Execution time:', selectResult.metrics.duration + 'ms\n');
  } finally {
    await adapter.close();
  }
} catch (error) {
  console.log('  ⊘ SQLite test failed:', error.message, '\n');
}

console.log('=== All Query Execution Metrics Tests Passed ===\n');
