xmlport 50904 "Implicit Rec XmlPort"
{
    schema
    {
        textelement(Root)
        {
            tableelement(CustLedgerEntry; "Cust. Ledger Entry")
            {
                trigger OnAfterGetRecord()
                begin
                    // Bare call, no receiver, in an XMLport tableelement's
                    // OnAfterGetRecord -- the implicit record here is the
                    // tableelement's own instance name (CustLedgerEntry), not
                    // the literal "Rec". Pins the "XMLport" gate arm
                    // specifically (not just "Table"/"Page"/"Report"): the
                    // reviewer proved changing "XMLport" to "XmlPort" or
                    // deleting it from IMPLICIT_RECORD_OBJECT_TYPES left the
                    // whole suite green before this fixture existed.
                    CalcFields(Amount);
                end;
            }
        }
    }
}
