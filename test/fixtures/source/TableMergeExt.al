tableextension 50971 "Merge Base Ext" extends "Merge Base"
{
    fields
    {
        field(50000; "Ext Code"; Code[20])
        {
        }
        field(50001; "Ext Lookup"; Text[100])
        {
            FieldClass = FlowField;
            CalcFormula = Lookup("Test Table".Description where("No." = field("No.")));
        }
        field(50002; "Ext Date Filter"; Date)
        {
            FieldClass = FlowFilter;
        }
        field(50003; "Ext Unresolved FlowField"; Decimal)
        {
            // A FlowField whose CalcFormula the extractor cannot type, so
            // `calcFormulaType` is undefined while `fieldClass` is FlowField.
            // 130 fields on a 15,436-file corpus were in this state before
            // `findCalcFormulaNode` learned the no-`where` and negated shapes;
            // 4 still are. A guard keyed only on `calcFormulaType` lets every
            // one of them through into a `SetLoadFields` suggestion that does
            // not compile.
            FieldClass = FlowField;
        }
        field(50004; "Ext Negated Sum"; Decimal)
        {
            // `CalcFormula = - sum(...)` is how every "balance owed" FlowField
            // in BC is written. The leading `-` leaves the property with no
            // `value` field, so keying off it dropped the formula entirely.
            FieldClass = FlowField;
            CalcFormula = - Sum("Test Table".Amount where("No." = field("No.")));
        }
        field(50005; "Ext Unfiltered Count"; Integer)
        {
            // An aggregate with NO `where` clause is not an `aggregate_formula`
            // in this grammar — it parses as an ordinary call expression.
            FieldClass = FlowField;
            CalcFormula = Count("Test Table");
        }
    }

    keys
    {
        // Deliberately reuses the root's secondary key NAME. Legal in AL as
        // long as the key holds no base-table fields, so a merge that
        // deduplicates by key name would silently drop this index.
        key(ByDate; "Ext Code")
        {
        }
        key(ByExtCode2; "Ext Code")
        {
        }
    }
}
