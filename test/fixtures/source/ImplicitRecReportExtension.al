reportextension 50907 "Implicit Rec Report Ext" extends "Standard Sales - Quote"
{
    dataset
    {
        addlast(Header)
        {
            dataitem(ExtraLedgerEntry; "Cust. Ledger Entry")
            {
                trigger OnAfterGetRecord()
                begin
                    // Bare call, no receiver, in a dataitem ADDED by a
                    // ReportExtension -- same `report_dataitem` node shape as
                    // a base report's own dataitem, so the implicit record is
                    // this dataitem's own name (ExtraLedgerEntry), not "Rec".
                    // Pins PER_ROW_TRIGGERS["ReportExtension"] (insideLoop)
                    // together with ReportExtension's membership in both
                    // IMPLICIT_RECORD_OBJECT_TYPES and
                    // DATAITEM_SCOPED_OBJECT_TYPES.
                    CalcFields(Amount);
                end;
            }
        }
    }
}
