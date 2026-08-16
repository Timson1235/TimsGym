import { relations } from 'drizzle-orm';
import { boolean, integer, json, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(), // Firebase Auth UID
  email: text('email').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

export const profiles = pgTable('profiles', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull()
    .unique(),
  name: text('name').notNull().default('Tim'),
  preferredUnit: text('preferred_unit').notNull().default('kg'),
  experienceLevel: text('experience_level').notNull().default('Intermediate'),
  primaryGoal: text('primary_goal').notNull().default('Hypertrophy'),
  personalMemories: json('personal_memories').$type<string[]>(),
  notes: text('notes'),
});

export const exercises = pgTable('exercises', {
  id: text('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  category: text('category').notNull(),
  equipment: text('equipment').notNull(),
  instructions: text('instructions'),
  isCustom: boolean('is_custom').default(false),
  personalRecord: json('personal_record'),
});

export const workouts = pgTable('workouts', {
  id: text('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  title: text('title').notNull(),
  date: text('date').notNull(),
  durationMinutes: integer('duration_minutes').notNull().default(0),
  totalVolume: integer('total_volume').notNull().default(0),
  isCompleted: boolean('is_completed').default(true),
  notes: text('notes'),
  exercisesData: json('exercises_data'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const usersRelations = relations(users, ({ one, many }) => ({
  profile: one(profiles, {
    fields: [users.id],
    references: [profiles.userId],
  }),
  exercises: many(exercises),
  workouts: many(workouts),
}));

export const profilesRelations = relations(profiles, ({ one }) => ({
  user: one(users, {
    fields: [profiles.userId],
    references: [users.id],
  }),
}));

export const exercisesRelations = relations(exercises, ({ one }) => ({
  user: one(users, {
    fields: [exercises.userId],
    references: [users.id],
  }),
}));

export const workoutsRelations = relations(workouts, ({ one }) => ({
  user: one(users, {
    fields: [workouts.userId],
    references: [users.id],
  }),
}));
