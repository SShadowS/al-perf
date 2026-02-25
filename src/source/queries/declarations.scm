;; Object declarations — captures object type, ID, and name
(codeunit_declaration
  object_id: (integer) @object_id
  object_name: [(identifier) (quoted_identifier)] @object_name) @codeunit

(table_declaration
  object_id: (integer) @object_id
  object_name: [(identifier) (quoted_identifier)] @object_name) @table

(page_declaration
  object_id: (integer) @object_id
  object_name: [(identifier) (quoted_identifier)] @object_name) @page

(report_declaration
  object_id: (integer) @object_id
  object_name: [(identifier) (quoted_identifier)] @object_name) @report

(query_declaration
  object_id: (integer) @object_id
  object_name: [(identifier) (quoted_identifier)] @object_name) @query

(xmlport_declaration
  object_id: (integer) @object_id
  object_name: [(identifier) (quoted_identifier)] @object_name) @xmlport

(enum_declaration
  object_id: (integer) @object_id
  object_name: [(identifier) (quoted_identifier)] @object_name) @enum

;; Procedure declarations
(procedure
  name: (name) @proc_name) @procedure

;; Trigger declarations
(trigger_declaration
  name: (trigger_name) @trigger_name) @trigger

;; OnRun trigger (special — no name field)
(onrun_trigger) @onrun
