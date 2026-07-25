codeunit 50950 "Old Style Calls"
{
    procedure ConvertSetups()
    var
        Customer: Record Customer;
        SalesLine: Record "Sales Line";
    begin
        // Classic C/AL: argument-less calls carry no parentheses. The grammar
        // parses these as member_expression, not call_expression, so without a
        // dedicated branch they read as FIELD accesses named "FindSet"/"Next"
        // and the record op is lost outright.
        if Customer.FindSet then
            repeat
                SalesLine.SetRange("Document No.", Customer."No.");
                if SalesLine.FindSet then
                    repeat
                        SalesLine.Modify;
                    until SalesLine.Next = 0;
            until Customer.Next = 0;
    end;
}
