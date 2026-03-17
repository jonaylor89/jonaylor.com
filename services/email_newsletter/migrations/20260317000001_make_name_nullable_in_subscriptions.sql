-- Make name nullable in subscriptions table
ALTER TABLE subscriptions ALTER COLUMN name DROP NOT NULL;
