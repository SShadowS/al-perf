table 50200 "CalcField Test Table"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; "Total Amount"; Decimal)
        {
            CalcFormula = Sum("Sales Line".Amount WHERE("Document No." = FIELD("No.")));
        }
        field(3; "Customer Name"; Text[100])
        {
            CalcFormula = Lookup(Customer.Name WHERE("No." = FIELD("Customer No.")));
        }
        field(4; "Line Count"; Integer)
        {
            CalcFormula = Count("Sales Line" WHERE("Document No." = FIELD("No.")));
        }
        field(5; "Customer No."; Code[20]) { }
    }
}
