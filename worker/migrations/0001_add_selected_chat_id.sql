ALTER TABLE relay_state ADD COLUMN selected_chat_id INTEGER CHECK (selected_chat_id IS NULL OR selected_chat_id > 0);
