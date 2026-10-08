import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const APPLY = process.argv.includes('--apply');
const CUSTOM_EXERCISES = {
  'Bizeps Kabel': ['Arms', 'Cable'],
  'Box Jumps': ['Legs', 'Bodyweight'],
  Butterfly: ['Chest', 'Machine'],
  Dips: ['Chest', 'Bodyweight'],
  'Einarmiger Cable Pulldown': ['Back', 'Cable'],
  'Einarmiges Rudern': ['Back', 'Dumbbell'],
  'Face Pulls': ['Shoulders', 'Cable'],
  'Kabel-Seitheben': ['Shoulders', 'Cable'],
  'Pallof Press': ['Core', 'Cable'],
  Rudermaschine: ['Back', 'Machine'],
  'Rudern Warm-up': ['Cardio', 'Machine'],
  'Schrägbank 30°': ['Chest', 'Barbell'],
  'Schulterdrücken KH': ['Shoulders', 'Dumbbell'],
  Seitheben: ['Shoulders', 'Dumbbell'],
  Sprünge: ['Legs', 'Bodyweight'],
  Trizepsdrücken: ['Arms', 'Cable'],
};

const ALIASES = {
  kniebeuge: 'Barbell Back Squat',
  squat: 'Barbell Back Squat',
  'back squat': 'Barbell Back Squat',
  rdl: 'Romanian Deadlift',
  schragbank: 'Schrägbank 30°',
  'schragbank 30': 'Schrägbank 30°',
};

function normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slug(value) {
  return normalize(value).replace(/ /g, '_');
}

const pool = new pg.Pool({
  host: process.env.SQL_HOST,
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  database: process.env.SQL_DB_NAME,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

const client = await pool.connect();
try {
  const users = (await client.query('SELECT id FROM users ORDER BY id')).rows;
  const report = [];
  if (APPLY) await client.query('BEGIN');

  for (const user of users) {
    const libraryRows = (await client.query(
      'SELECT id, name, category, equipment FROM exercises WHERE user_id = $1',
      [user.id],
    )).rows;
    const byName = new Map(libraryRows.map((item) => [normalize(item.name), item]));

    for (const [name, [category, equipment]] of Object.entries(CUSTOM_EXERCISES)) {
      if (byName.has(normalize(name))) continue;
      const exercise = {
        id: `ex_canonical_${slug(name)}_${user.id}`,
        name,
        category,
        equipment,
      };
      byName.set(normalize(name), exercise);
      if (APPLY) {
        await client.query(
          `INSERT INTO exercises (id, user_id, name, category, equipment, instructions, is_custom)
           VALUES ($1, $2, $3, $4, $5, $6, TRUE) ON CONFLICT (id) DO NOTHING`,
          [exercise.id, user.id, name, category, equipment, 'Canonical exercise created during history normalization.'],
        );
      }
    }

    const workouts = (await client.query(
      'SELECT id, date, exercises_data FROM workouts WHERE user_id = $1 ORDER BY date, id',
      [user.id],
    )).rows;
    const personalRecords = new Map();
    let changedEntries = 0;

    for (const workout of workouts) {
      const exercises = Array.isArray(workout.exercises_data) ? workout.exercises_data : [];
      let workoutChanged = false;
      for (const entry of exercises) {
        const normalizedOriginal = normalize(entry.exerciseName);
        const targetName = ALIASES[normalizedOriginal] || entry.exerciseName;
        const canonical = byName.get(normalize(targetName));
        if (!canonical) throw new Error(`No canonical exercise for "${entry.exerciseName}" (user ${user.id})`);

        if (entry.exerciseId !== canonical.id || entry.exerciseName !== canonical.name || entry.category !== canonical.category) {
          report.push({ date: workout.date, from: `${entry.exerciseName} [${entry.exerciseId}]`, to: `${canonical.name} [${canonical.id}]` });
          entry.exerciseId = canonical.id;
          entry.exerciseName = canonical.name;
          entry.category = canonical.category;
          workoutChanged = true;
          changedEntries += 1;
        }

        for (const set of entry.sets || []) {
          if (!set.completed || !(set.weight > 0) || !(set.reps > 0)) continue;
          const estimate = Math.round(set.weight * (1 + set.reps / 30));
          const current = personalRecords.get(canonical.id);
          if (!current || estimate > current.calculatedOneRepMax) {
            personalRecords.set(canonical.id, {
              maxWeight: set.weight,
              maxReps: set.reps,
              calculatedOneRepMax: estimate,
              date: workout.date,
            });
          }
        }
      }
      if (APPLY && workoutChanged) {
        await client.query('UPDATE workouts SET exercises_data = $1::json WHERE id = $2 AND user_id = $3', [JSON.stringify(exercises), workout.id, user.id]);
      }
    }

    if (APPLY) {
      for (const [exerciseId, record] of personalRecords) {
        await client.query(
          'UPDATE exercises SET personal_record = $1::json WHERE id = $2 AND user_id = $3',
          [JSON.stringify(record), exerciseId, user.id],
        );
      }
    }
    console.log(`User ${user.id}: ${changedEntries} workout exercise entries ${APPLY ? 'updated' : 'would change'}.`);
  }

  console.table(report);
  if (APPLY) await client.query('COMMIT');
  console.log(APPLY ? 'Normalization committed.' : 'Dry run only. Re-run with --apply to commit.');
} catch (error) {
  if (APPLY) await client.query('ROLLBACK');
  console.error(error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
