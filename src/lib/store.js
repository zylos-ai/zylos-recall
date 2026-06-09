import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export class ChunkStore {
  constructor(indexPath) {
    this.indexPath = indexPath;
    fs.mkdirSync(path.dirname(indexPath), { recursive: true, mode: 0o700 });
    this.db = new Database(indexPath);
    sqliteVec.load(this.db);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
  }

  close() {
    this.db.close();
  }

  initialize(embedder) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        section TEXT NOT NULL,
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        token_count INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        embeddings_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
      CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(hash);
      CREATE TABLE IF NOT EXISTS embeddings (
        id INTEGER PRIMARY KEY,
        chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
        embedder_id TEXT NOT NULL,
        vector_index INTEGER NOT NULL,
        hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(chunk_id, embedder_id, vector_index)
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_chunk ON embeddings(chunk_id);
      CREATE INDEX IF NOT EXISTS idx_embeddings_embedder ON embeddings(embedder_id);
    `);

    const current = this.getEmbedderMeta();
    if (!this.vectorTableExists()) {
      this.createVectorTable(embedder.dimension());
    }
    if (
      current &&
      (current.id !== embedder.id() || current.dimension !== embedder.dimension())
    ) {
      this.fullReindex(embedder);
    } else {
      this.setEmbedderMeta(embedder);
    }
  }

  vectorTableExists() {
    const row = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'vec_embeddings'
    `).get();
    return Boolean(row);
  }

  createVectorTable(dimension) {
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(embedding float[${dimension}])`);
  }

  getEmbedderMeta() {
    const id = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('embedder_id')?.value;
    const dimension = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('embedder_dimension')?.value;
    if (!id || !dimension) return null;
    return { id, dimension: Number(dimension) };
  }

  setEmbedderMeta(embedder) {
    const upsert = this.db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    upsert.run('embedder_id', embedder.id());
    upsert.run('embedder_dimension', String(embedder.dimension()));
  }

  fullReindex(embedder) {
    this.db.exec(`
      DROP TABLE IF EXISTS vec_embeddings;
      DELETE FROM embeddings;
      DELETE FROM chunks;
    `);
    this.createVectorTable(embedder.dimension());
    this.setEmbedderMeta(embedder);
  }

  getChunk(id) {
    const row = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(id);
    return row ? rowToChunk(row) : null;
  }

  replaceCorpus(chunks, embedderId, embeddedVectors) {
    const now = Date.now();
    const seenIds = new Set(chunks.map(chunk => chunk.id));
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let removed = 0;

    const selectAllChunkIds = this.db.prepare('SELECT id FROM chunks');
    const selectEmbeddingIds = this.db.prepare('SELECT id FROM embeddings WHERE chunk_id = ?');
    const deleteVector = this.db.prepare('DELETE FROM vec_embeddings WHERE rowid = ?');
    const deleteChunk = this.db.prepare('DELETE FROM chunks WHERE id = ?');
    const selectChunk = this.db.prepare('SELECT hash FROM chunks WHERE id = ?');
    const upsertChunk = this.db.prepare(`
      INSERT INTO chunks (
        id, text, source, section, hash, mtime, token_count,
        metadata_json, embeddings_json, created_at, updated_at
      ) VALUES (
        @id, @text, @source, @section, @hash, @mtime, @tokenCount,
        @metadataJson, @embeddingsJson, @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        text = excluded.text,
        source = excluded.source,
        section = excluded.section,
        hash = excluded.hash,
        mtime = excluded.mtime,
        token_count = excluded.token_count,
        metadata_json = excluded.metadata_json,
        embeddings_json = excluded.embeddings_json,
        updated_at = excluded.updated_at
    `);
    const deleteEmbeddings = this.db.prepare('DELETE FROM embeddings WHERE chunk_id = ?');
    const insertEmbedding = this.db.prepare(`
      INSERT INTO embeddings(chunk_id, embedder_id, vector_index, hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertVector = this.db.prepare('INSERT INTO vec_embeddings(rowid, embedding) VALUES (?, ?)');

    const tx = this.db.transaction(() => {
      const existingIds = selectAllChunkIds.all().map(row => row.id);
      for (const id of existingIds) {
        if (seenIds.has(id)) continue;
        for (const row of selectEmbeddingIds.all(id)) {
          deleteVector.run(BigInt(row.id));
        }
        removed += deleteChunk.run(id).changes;
      }

      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        const existing = selectChunk.get(chunk.id);
        const vectors = embeddedVectors[index];
        const embeddings = vectors.map((vector, vectorIndex) => ({
          embedder_id: embedderId,
          vector,
          vector_index: vectorIndex
        }));

        upsertChunk.run({
          ...chunk,
          metadataJson: JSON.stringify(chunk.metadata),
          embeddingsJson: JSON.stringify(embeddings),
          createdAt: now,
          updatedAt: now
        });

        const isUnchanged = existing?.hash === chunk.hash;
        if (!existing) inserted += 1;
        else if (isUnchanged) unchanged += 1;
        else updated += 1;

        if (!isUnchanged) {
          for (const row of selectEmbeddingIds.all(chunk.id)) {
            deleteVector.run(BigInt(row.id));
          }
          deleteEmbeddings.run(chunk.id);
          for (const embedding of embeddings) {
            const result = insertEmbedding.run(
              chunk.id,
              embedderId,
              embedding.vector_index,
              chunk.hash,
              now
            );
            insertVector.run(BigInt(result.lastInsertRowid), JSON.stringify(embedding.vector));
          }
        }
      }
    });

    tx();
    return { inserted, updated, unchanged, removed, total: chunks.length };
  }

  search(vector, { topK = 5 } = {}) {
    const rows = this.db.prepare(`
      SELECT
        c.id,
        c.text,
        c.source,
        c.section,
        c.hash,
        c.mtime,
        c.token_count,
        c.metadata_json,
        e.embedder_id,
        v.distance
      FROM vec_embeddings v
      JOIN embeddings e ON e.id = v.rowid
      JOIN chunks c ON c.id = e.chunk_id
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance
    `).all(JSON.stringify(vector), topK);

    return rows.map(row => ({
      ...rowToChunk(row),
      embedderId: row.embedder_id,
      distance: row.distance,
      score: 1 / (1 + row.distance)
    }));
  }
}

function rowToChunk(row) {
  return {
    id: row.id,
    text: row.text,
    source: row.source,
    section: row.section,
    hash: row.hash,
    mtime: row.mtime,
    tokenCount: row.token_count,
    metadata: JSON.parse(row.metadata_json),
    embeddings: row.embeddings_json ? JSON.parse(row.embeddings_json) : []
  };
}
