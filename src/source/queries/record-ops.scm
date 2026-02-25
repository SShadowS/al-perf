;; Method calls on record variables: Rec.FindSet(), Rec.Modify(), etc.
;; Captures the object (record variable), method name, and full call
(call_expression
  function: (member_expression
    object: (identifier) @record_var
    property: (identifier) @method_name)) @record_op

;; Method calls via field access: Rec."Field Name"()
(call_expression
  function: (field_access
    record: (identifier) @record_var
    field: (quoted_identifier) @method_name)) @record_op_quoted
